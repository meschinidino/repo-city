use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_ast::ast::Statement;
use oxc_parser::{ParseOptions, Parser};
use oxc_resolver::{ResolveOptions, Resolver, TsconfigDiscovery};
use oxc_span::SourceType;
use serde::Serialize;

const SOURCE_EXTENSIONS: [&str; 9] = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "py"];
const SKIP_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    "coverage",
    "out",
    ".turbo",
];
/// Importer count at or above which a file counts as a shared utility.
pub const SHARED_UTILITY_MIN_IMPORTERS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    EntryPoint,
    ExposesEndpoints,
    DataAccess,
    UiComponent,
    SharedUtility,
    Generated,
    Vendored,
    DeadCode,
    Ordinary,
}

impl Role {
    pub fn building(self) -> &'static str {
        match self {
            Role::EntryPoint => "keep",
            Role::ExposesEndpoints => "sea_gate",
            Role::DataAccess => "silos",
            Role::UiComponent => "market",
            Role::SharedUtility => "lighthouse",
            Role::Generated | Role::Vendored => "containers",
            Role::DeadCode => "ruin",
            Role::Ordinary => "cottage",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Counts {
    pub files_parsed: usize,
    pub files_with_parse_errors: usize,
    pub total_imports: usize,
    pub resolved_imports: usize,
    pub unresolved_imports: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Island {
    pub id: String,
    pub name: String,
    /// Repo-relative path of the island root, POSIX separators.
    pub path: String,
    pub file_count: usize,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub island_id: String,
    pub roles: Vec<Role>,
    /// DESIGN.md building type derived from the highest-priority role.
    pub building: String,
    pub import_count: usize,
    pub importer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Edge {
    pub from_file: String,
    pub to_file: String,
    pub specifier: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Bridge {
    pub from_island: String,
    pub to_island: String,
    pub count: usize,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnresolvedImport {
    pub from_file: String,
    pub specifier: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParseError {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Extraction {
    pub schema_version: u32,
    /// True when the scanned tree lives under a `fixtures/` directory.
    pub is_stand_in_fixture: bool,
    pub repo_root: String,
    pub counts: Counts,
    pub islands: Vec<Island>,
    pub files: Vec<FileInfo>,
    pub bridges: Vec<Bridge>,
    pub unresolved: Vec<UnresolvedImport>,
    pub parse_errors: Vec<ParseError>,
}

#[derive(Debug)]
struct IslandDef {
    id: String,
    name: String,
    abs_path: PathBuf,
    rel_path: String,
    entry_files: HashSet<PathBuf>,
}

#[derive(Debug)]
struct RawFile {
    abs_path: PathBuf,
    rel_path: String,
    island_idx: usize,
    source: String,
    specifiers: Vec<String>,
    parse_error: Option<String>,
}

fn is_source_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SOURCE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn to_posix(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn rel_posix(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(r) if r.as_os_str().is_empty() => ".".to_string(),
        Ok(r) => to_posix(r),
        Err(_) => to_posix(path),
    }
}

fn collect_source_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        entries.sort();
        for entry in entries {
            let name = entry
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if entry.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(entry);
                }
            } else if is_source_file(&entry) {
                out.push(entry);
            }
        }
    }
    out.sort();
    out
}

fn read_package_json(dir: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn collect_entry_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_entry_strings(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_entry_strings(item, out);
            }
        }
        _ => {}
    }
}

fn package_entry_files(pkg_dir: &Path, pkg: &serde_json::Value) -> HashSet<PathBuf> {
    let mut strings = Vec::new();
    for key in ["main", "module", "types"] {
        if let Some(v) = pkg.get(key) {
            collect_entry_strings(v, &mut strings);
        }
    }
    if let Some(exports) = pkg.get("exports") {
        collect_entry_strings(exports, &mut strings);
    }
    let mut out = HashSet::new();
    for s in strings {
        if !is_source_file(Path::new(&s)) {
            continue;
        }
        let candidate = pkg_dir.join(&s);
        if let Ok(canon) = candidate.canonicalize() {
            out.insert(canon);
        } else if candidate.exists() {
            out.insert(candidate);
        }
    }
    out
}

fn expand_workspace_globs(root: &Path, patterns: &[String]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for pattern in patterns {
        let pattern = pattern.trim_end_matches('/');
        if let Some(prefix) = pattern.strip_suffix("/*") {
            let base = root.join(prefix);
            if let Ok(entries) = std::fs::read_dir(&base) {
                let mut sub: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_dir())
                    .collect();
                sub.sort();
                dirs.extend(sub);
            }
        } else if !pattern.contains('*') {
            dirs.push(root.join(pattern));
        }
        // Non-trivial globs are not expanded in this spike; they fall through
        // to the directory-first fallback if they match no package below.
    }
    dirs
}

fn discover_islands(root: &Path, files: &[PathBuf]) -> Vec<IslandDef> {
    let mut islands: Vec<IslandDef> = Vec::new();
    if let Some(root_pkg) = read_package_json(root) {
        let mut patterns: Vec<String> = Vec::new();
        match root_pkg.get("workspaces") {
            Some(serde_json::Value::Array(items)) => {
                patterns.extend(items.iter().filter_map(|v| v.as_str().map(str::to_owned)));
            }
            Some(serde_json::Value::Object(map)) => {
                if let Some(serde_json::Value::Array(items)) = map.get("packages") {
                    patterns.extend(items.iter().filter_map(|v| v.as_str().map(str::to_owned)));
                }
            }
            _ => {}
        }
        for dir in expand_workspace_globs(root, &patterns) {
            let Some(pkg) = read_package_json(&dir) else {
                continue;
            };
            let name = pkg
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| {
                    dir.file_name()
                        .unwrap_or_default()
                        .to_str()
                        .unwrap_or("package")
                })
                .to_string();
            islands.push(IslandDef {
                id: name.clone(),
                name,
                entry_files: package_entry_files(&dir, &pkg),
                rel_path: rel_posix(root, &dir),
                abs_path: dir,
            });
        }
    }
    if !islands.is_empty() {
        return islands;
    }
    // Single-package districts: a `features/<name>` or `modules/<name>`
    // directory is an island. These are added alongside the top-level
    // fallback below; longest-prefix matching assigns their files here.
    let mut feature_roots: BTreeMap<PathBuf, String> = BTreeMap::new();
    for file in files {
        let Ok(rel) = file.strip_prefix(root) else {
            continue;
        };
        let comps: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        for (i, comp) in comps.iter().enumerate() {
            if (comp == "features" || comp == "modules") && i + 2 < comps.len() {
                let island_root = root.join(comps[..=i + 1].join("/"));
                let rel_id = comps[..=i + 1].join("/");
                feature_roots.entry(island_root).or_insert(rel_id);
                break;
            }
        }
    }
    for (dir, rel_id) in feature_roots {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| rel_id.clone());
        islands.push(IslandDef {
            id: rel_id.clone(),
            name,
            rel_path: rel_id,
            abs_path: dir,
            entry_files: HashSet::new(),
        });
    }
    // Directory-first fallback: one island per top-level directory that
    // contains source files, plus a root island for loose root files.
    let mut by_dir: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut has_root_files = false;
    for file in files {
        let Ok(rel) = file.strip_prefix(root) else {
            continue;
        };
        let mut comps = rel.components();
        match (comps.next(), comps.next()) {
            (Some(first), Some(_)) => {
                let name = first.as_os_str().to_string_lossy().into_owned();
                by_dir
                    .entry(name)
                    .or_insert_with(|| root.join(first.as_os_str()));
            }
            (Some(_), None) => has_root_files = true,
            _ => {}
        }
    }
    for (name, dir) in by_dir {
        let entry_files = read_package_json(&dir)
            .map(|pkg| package_entry_files(&dir, &pkg))
            .unwrap_or_default();
        islands.push(IslandDef {
            id: name.clone(),
            name,
            rel_path: rel_posix(root, &dir),
            abs_path: dir,
            entry_files,
        });
    }
    if has_root_files {
        islands.push(IslandDef {
            id: "root".to_string(),
            name: "root".to_string(),
            rel_path: ".".to_string(),
            abs_path: root.to_path_buf(),
            entry_files: HashSet::new(),
        });
    }
    islands
}

fn island_index_for(islands: &[IslandDef], file: &Path) -> Option<usize> {
    // Longest matching island root wins (workspace packages are disjoint,
    // but this keeps nested roots deterministic).
    let mut best: Option<(usize, usize)> = None;
    for (idx, island) in islands.iter().enumerate() {
        if file.starts_with(&island.abs_path) {
            let depth = island.abs_path.components().count();
            if best.is_none_or(|(_, d)| depth > d) {
                best = Some((idx, depth));
            }
        }
    }
    best.map(|(idx, _)| idx)
}

fn parse_python_imports(source: &str) -> (Vec<String>, Option<String>) {
    let suite = match <rustpython_parser::ast::Suite as rustpython_parser::Parse>::parse(
        source, "<module>",
    ) {
        Ok(suite) => suite,
        Err(err) => return (Vec::new(), Some(err.to_string())),
    };
    let mut specifiers = Vec::new();
    for stmt in &suite {
        match stmt {
            rustpython_parser::ast::Stmt::Import(import) => {
                for alias in &import.names {
                    specifiers.push(alias.name.as_str().to_string());
                }
            }
            rustpython_parser::ast::Stmt::ImportFrom(import) => {
                let level = import.level.as_ref().map(|v| v.to_usize()).unwrap_or(0);
                let dots = ".".repeat(level);
                let module = import.module.as_ref().map(|m| m.as_str()).unwrap_or("");
                specifiers.push(format!("{dots}{module}"));
            }
            _ => {}
        }
    }
    (specifiers, None)
}

fn parse_imports(path: &Path, source: &str) -> (Vec<String>, Option<String>) {
    if path.extension().and_then(|e| e.to_str()) == Some("py") {
        return parse_python_imports(source);
    }
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();
    let mut specifiers = Vec::new();
    for stmt in &ret.program.body {
        let specifier = match stmt {
            Statement::ImportDeclaration(decl) => Some(&decl.source.value),
            Statement::ExportAllDeclaration(decl) => Some(&decl.source.value),
            Statement::ExportFromDeclaration(decl) => Some(&decl.source.value),
            _ => None,
        };
        if let Some(value) = specifier {
            if let Some(s) = value.as_str() {
                specifiers.push(s.to_string());
            }
        }
    }
    let error = if ret.diagnostics.is_empty() {
        None
    } else {
        Some(
            ret.diagnostics
                .iter()
                .map(|d| d.to_string())
                .collect::<Vec<_>>()
                .join("; "),
        )
    };
    (specifiers, error)
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

fn classify(
    rel_path: &str,
    source: &str,
    is_entry: bool,
    importer_count: usize,
) -> (Vec<Role>, &'static str) {
    let lower_path = rel_path.to_ascii_lowercase();
    let components: Vec<&str> = lower_path.split('/').collect();
    let file_name = components.last().copied().unwrap_or("");
    let stem = file_name.split('.').next().unwrap_or("");
    let head: String = source.chars().take(600).collect();
    let lower_source = source.to_ascii_lowercase();

    let generated = components
        .iter()
        .any(|c| *c == "generated" || *c == "__generated__")
        || contains_any(
            &head,
            &[
                "@generated",
                "DO NOT EDIT",
                "auto-generated",
                "automatically generated",
            ],
        );
    let vendored = components
        .iter()
        .any(|c| matches!(*c, "vendor" | "vendored" | "third_party" | "third-party"));
    let exposes_endpoints = components
        .iter()
        .any(|c| matches!(*c, "routes" | "route" | "endpoints" | "handlers"))
        || matches!(stem, "route" | "routes" | "router" | "routers")
        || contains_any(
            source,
            &[
                "export async function GET",
                "export async function POST",
                "export async function PUT",
                "export async function DELETE",
                "export async function PATCH",
                "export function GET",
                "export function POST",
                "APIRouter",
                "router.get(",
                "router.post(",
                "router.put(",
                "router.delete(",
                ".route(",
            ],
        );
    let data_access = components
        .iter()
        .any(|c| matches!(*c, "db" | "data" | "repositories" | "models"))
        || contains_any(stem, &["repo", "repository", "store", "db"])
        || contains_any(
            &lower_source,
            &[
                "select ",
                "insert into",
                "prisma.",
                "db.query",
                "createclient(",
                "drizzle",
            ],
        );
    let extension = file_name.rsplit('.').next().unwrap_or("");
    let ui_component = matches!(extension, "tsx" | "jsx")
        || (stem.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            && source.contains('<')
            && contains_any(source, &["return (", "return <"]));
    let shared_utility = importer_count >= SHARED_UTILITY_MIN_IMPORTERS;
    let dead_code = importer_count == 0 && !is_entry;

    let mut roles: Vec<Role> = Vec::new();
    if is_entry {
        roles.push(Role::EntryPoint);
    }
    if exposes_endpoints {
        roles.push(Role::ExposesEndpoints);
    }
    if data_access {
        roles.push(Role::DataAccess);
    }
    if ui_component {
        roles.push(Role::UiComponent);
    }
    if shared_utility {
        roles.push(Role::SharedUtility);
    }
    if generated {
        roles.push(Role::Generated);
    }
    if vendored {
        roles.push(Role::Vendored);
    }
    if dead_code {
        roles.push(Role::DeadCode);
    }
    if roles.is_empty() {
        roles.push(Role::Ordinary);
    }
    // Highest-priority role decides the building. Generated/vendored is
    // checked before dead code so a generated file with no importers still
    // reads as containers, not a ruin; its DeadCode role is still listed.
    let priority = [
        Role::EntryPoint,
        Role::ExposesEndpoints,
        Role::DataAccess,
        Role::Generated,
        Role::Vendored,
        Role::UiComponent,
        Role::SharedUtility,
        Role::DeadCode,
        Role::Ordinary,
    ];
    let primary = priority
        .iter()
        .copied()
        .find(|r| roles.contains(r))
        .unwrap_or(Role::Ordinary);
    (roles, primary.building())
}

fn resolve_python_target(
    file: &Path,
    specifier: &str,
    by_canon: &HashMap<PathBuf, usize>,
) -> Option<usize> {
    let level = specifier.chars().take_while(|c| *c == '.').count();
    let module = specifier.trim_start_matches('.');
    let parts: Vec<&str> = module.split('.').filter(|s| !s.is_empty()).collect();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if level > 0 {
        let mut base = file.parent()?.to_path_buf();
        for _ in 1..level {
            base = base.parent()?.to_path_buf();
        }
        candidates.push(base.join(parts.join("/")));
    } else {
        let mut current = file.parent().map(Path::to_path_buf);
        while let Some(dir) = current {
            candidates.push(dir.join(parts.join("/")));
            current = dir.parent().map(Path::to_path_buf);
        }
    }
    for candidate in candidates {
        let file_candidate = candidate.with_extension("py");
        if let Some(idx) = by_canon.get(&file_candidate) {
            return Some(*idx);
        }
        let init_candidate = candidate.join("__init__.py");
        if let Some(idx) = by_canon.get(&init_candidate) {
            return Some(*idx);
        }
        if candidate.extension().and_then(|e| e.to_str()) == Some("py") {
            if let Some(idx) = by_canon.get(&candidate) {
                return Some(*idx);
            }
        }
    }
    None
}

/// Scan `root` and produce the extraction summary.
///
/// Counts `total_imports` over static `import` declarations and
/// `export ... from` re-exports found by the Oxc parser. Dynamic `import()`
/// is not counted in this spike. A specifier counts as resolved when
/// `oxc_resolver` resolves it to a file; only resolved targets inside the
/// scanned file set become import edges / bridges.
pub fn extract_repo(root: &Path) -> std::io::Result<Extraction> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let files_on_disk = collect_source_files(&root);
    let islands_def = discover_islands(&root, &files_on_disk);

    let mut raw_files: Vec<RawFile> = Vec::new();
    for abs in &files_on_disk {
        let Some(island_idx) = island_index_for(&islands_def, abs) else {
            continue;
        };
        let source = std::fs::read_to_string(abs).unwrap_or_default();
        let (specifiers, parse_error) = parse_imports(abs, &source);
        raw_files.push(RawFile {
            abs_path: abs.clone(),
            rel_path: rel_posix(&root, abs),
            island_idx,
            source,
            specifiers,
            parse_error,
        });
    }

    // Canonical path -> raw file index, for turning resolved paths into edges.
    let mut by_canon: HashMap<PathBuf, usize> = HashMap::new();
    for (idx, f) in raw_files.iter().enumerate() {
        if let Ok(canon) = f.abs_path.canonicalize() {
            by_canon.insert(canon, idx);
        }
        by_canon.entry(f.abs_path.clone()).or_insert(idx);
    }

    let resolver = Resolver::new(ResolveOptions {
        extensions: SOURCE_EXTENSIONS
            .iter()
            .filter(|e| **e != "py")
            .map(|e| format!(".{e}"))
            .chain([".json".to_string()])
            .collect(),
        condition_names: vec![
            "import".into(),
            "require".into(),
            "types".into(),
            "node".into(),
            "default".into(),
        ],
        main_fields: vec!["main".into(), "module".into(), "types".into()],
        tsconfig: Some(TsconfigDiscovery::Auto),
        ..ResolveOptions::default()
    });

    let mut total_imports = 0usize;
    let mut resolved_imports = 0usize;
    let mut unresolved: Vec<UnresolvedImport> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut importer_counts: Vec<usize> = vec![0; raw_files.len()];
    let mut import_counts: Vec<usize> = vec![0; raw_files.len()];

    for (idx, file) in raw_files.iter().enumerate() {
        import_counts[idx] = file.specifiers.len();
        total_imports += file.specifiers.len();
        for specifier in &file.specifiers {
            if file.abs_path.extension().and_then(|e| e.to_str()) == Some("py") {
                match resolve_python_target(&file.abs_path, specifier, &by_canon) {
                    Some(target_idx) => {
                        resolved_imports += 1;
                        importer_counts[target_idx] += 1;
                        edges.push(Edge {
                            from_file: file.rel_path.clone(),
                            to_file: raw_files[target_idx].rel_path.clone(),
                            specifier: specifier.clone(),
                        });
                    }
                    None => unresolved.push(UnresolvedImport {
                        from_file: file.rel_path.clone(),
                        specifier: specifier.clone(),
                    }),
                }
                continue;
            }
            match resolver.resolve_file(&file.abs_path, specifier) {
                Ok(resolution) => {
                    resolved_imports += 1;
                    let resolved_path = resolution.path();
                    let canon = resolved_path
                        .canonicalize()
                        .unwrap_or_else(|_| resolved_path.to_path_buf());
                    if let Some(&target_idx) =
                        by_canon.get(&canon).or_else(|| by_canon.get(resolved_path))
                    {
                        importer_counts[target_idx] += 1;
                        edges.push(Edge {
                            from_file: file.rel_path.clone(),
                            to_file: raw_files[target_idx].rel_path.clone(),
                            specifier: specifier.clone(),
                        });
                    }
                }
                Err(_) => {
                    unresolved.push(UnresolvedImport {
                        from_file: file.rel_path.clone(),
                        specifier: specifier.clone(),
                    });
                }
            }
        }
    }

    let mut files: Vec<FileInfo> = Vec::new();
    for (idx, file) in raw_files.iter().enumerate() {
        let canon = file
            .abs_path
            .canonicalize()
            .unwrap_or_else(|_| file.abs_path.clone());
        let stem = file
            .abs_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_entry = islands_def[file.island_idx].entry_files.contains(&canon)
            || islands_def[file.island_idx]
                .entry_files
                .contains(&file.abs_path)
            || matches!(stem.as_str(), "main" | "__main__");
        let (roles, building) =
            classify(&file.rel_path, &file.source, is_entry, importer_counts[idx]);
        files.push(FileInfo {
            path: file.rel_path.clone(),
            island_id: islands_def[file.island_idx].id.clone(),
            roles,
            building: building.to_string(),
            import_count: import_counts[idx],
            importer_count: importer_counts[idx],
        });
    }

    let mut islands: Vec<Island> = islands_def
        .iter()
        .map(|def| Island {
            id: def.id.clone(),
            name: def.name.clone(),
            path: def.rel_path.clone(),
            file_count: 0,
            files: Vec::new(),
        })
        .collect();
    for file in raw_files.iter() {
        islands[file.island_idx].files.push(file.rel_path.clone());
        islands[file.island_idx].file_count += 1;
    }
    for island in &mut islands {
        island.files.sort();
    }
    islands.sort_by(|a, b| a.id.cmp(&b.id));
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let island_of_file: HashMap<&str, &str> = files
        .iter()
        .map(|f| (f.path.as_str(), f.island_id.as_str()))
        .collect();
    let mut bridge_map: BTreeMap<(String, String), Vec<Edge>> = BTreeMap::new();
    for edge in edges {
        let (Some(&from_island), Some(&to_island)) = (
            island_of_file.get(edge.from_file.as_str()),
            island_of_file.get(edge.to_file.as_str()),
        ) else {
            continue;
        };
        if from_island != to_island {
            bridge_map
                .entry((from_island.to_string(), to_island.to_string()))
                .or_default()
                .push(edge);
        }
    }
    let bridges: Vec<Bridge> = bridge_map
        .into_iter()
        .map(|((from_island, to_island), mut edges)| {
            edges.sort_by(|a, b| (&a.from_file, &a.to_file).cmp(&(&b.from_file, &b.to_file)));
            Bridge {
                count: edges.len(),
                from_island,
                to_island,
                edges,
            }
        })
        .collect();

    let parse_errors: Vec<ParseError> = raw_files
        .iter()
        .filter_map(|f| {
            f.parse_error.as_ref().map(|message| ParseError {
                file: f.rel_path.clone(),
                message: message.clone(),
            })
        })
        .collect();

    unresolved.sort_by(|a, b| (&a.from_file, &a.specifier).cmp(&(&b.from_file, &b.specifier)));

    Ok(Extraction {
        schema_version: 1,
        is_stand_in_fixture: root.components().any(|c| c.as_os_str() == "fixtures"),
        repo_root: root.to_string_lossy().into_owned(),
        counts: Counts {
            files_parsed: raw_files.len(),
            files_with_parse_errors: parse_errors.len(),
            total_imports,
            resolved_imports,
            unresolved_imports: unresolved.len(),
        },
        islands,
        files,
        bridges,
        unresolved,
        parse_errors,
    })
}

/// Serialize an extraction as JSON for the client.
pub fn to_json(extraction: &Extraction, pretty: bool) -> Result<String, serde_json::Error> {
    if pretty {
        serde_json::to_string_pretty(extraction)
    } else {
        serde_json::to_string(extraction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn building_mapping_matches_design() {
        assert_eq!(Role::EntryPoint.building(), "keep");
        assert_eq!(Role::ExposesEndpoints.building(), "sea_gate");
        assert_eq!(Role::DataAccess.building(), "silos");
        assert_eq!(Role::SharedUtility.building(), "lighthouse");
        assert_eq!(Role::UiComponent.building(), "market");
        assert_eq!(Role::Generated.building(), "containers");
        assert_eq!(Role::DeadCode.building(), "ruin");
        assert_eq!(Role::Ordinary.building(), "cottage");
    }

    #[test]
    fn classify_route_and_generated() {
        let (roles, building) = classify(
            "packages/api/src/routes/users.ts",
            "export async function GET() { return 'ok'; }",
            false,
            1,
        );
        assert!(roles.contains(&Role::ExposesEndpoints));
        assert_eq!(building, "sea_gate");

        let (roles, building) = classify(
            "packages/web/src/generated/client.ts",
            "// @generated\n export const x = 1;",
            false,
            0,
        );
        assert!(roles.contains(&Role::Generated));
        assert!(roles.contains(&Role::DeadCode));
        assert_eq!(building, "containers");
    }

    #[test]
    fn parse_imports_counts_reexports() {
        let (specs, err) = parse_imports(
            Path::new("index.ts"),
            "import a from './a';\nexport * from './b';\nexport { c } from './c';\nexport const d = 1;\n",
        );
        assert!(err.is_none());
        assert_eq!(specs, vec!["./a", "./b", "./c"]);
    }
}
