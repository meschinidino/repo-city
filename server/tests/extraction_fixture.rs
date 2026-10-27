//! Tests against the stand-in fixture monorepo.
//!
//! The fixture is a stand-in, not the real demo repo. These tests prove
//! extraction translation on hand-counted fixture values only.

use std::collections::BTreeMap;
use std::path::PathBuf;

use repo_city_server::extract::{extract_repo, Role};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample-monorepo")
}

fn file<'a>(
    extraction: &'a repo_city_server::Extraction,
    path: &str,
) -> &'a repo_city_server::FileInfo {
    extraction
        .files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| panic!("file not found in extraction: {path}"))
}

#[test]
fn stand_in_fixture_counts_match_hand_count() {
    let extraction = extract_repo(&fixture_root()).expect("extract stand-in fixture");

    assert!(
        extraction.is_stand_in_fixture,
        "fixture must be labeled a stand-in"
    );
    assert_eq!(extraction.counts.files_parsed, 12);
    assert_eq!(extraction.counts.files_with_parse_errors, 0);
    assert_eq!(extraction.counts.total_imports, 16);
    assert_eq!(extraction.counts.resolved_imports, 14);
    assert_eq!(extraction.counts.unresolved_imports, 2);
}

#[test]
fn stand_in_fixture_unresolved_are_listed() {
    let extraction = extract_repo(&fixture_root()).expect("extract stand-in fixture");
    let unresolved: Vec<(&str, &str)> = extraction
        .unresolved
        .iter()
        .map(|u| (u.from_file.as_str(), u.specifier.as_str()))
        .collect();
    assert_eq!(
        unresolved,
        vec![
            ("packages/api/src/broken.ts", "./does-not-exist"),
            ("packages/api/src/broken.ts", "@fixture/ghost"),
        ]
    );
}

#[test]
fn stand_in_fixture_islands_are_workspace_packages() {
    let extraction = extract_repo(&fixture_root()).expect("extract stand-in fixture");
    let ids: Vec<&str> = extraction.islands.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "@fixture/api",
            "@fixture/cli",
            "@fixture/shared",
            "@fixture/web"
        ]
    );
    let counts: BTreeMap<&str, usize> = extraction
        .islands
        .iter()
        .map(|i| (i.id.as_str(), i.file_count))
        .collect();
    assert_eq!(counts["@fixture/shared"], 4);
    assert_eq!(counts["@fixture/api"], 4);
    assert_eq!(counts["@fixture/web"], 3);
    assert_eq!(counts["@fixture/cli"], 1);
}

#[test]
fn stand_in_fixture_bridges_are_counted_per_island_pair() {
    let extraction = extract_repo(&fixture_root()).expect("extract stand-in fixture");
    let bridges: BTreeMap<(&str, &str), usize> = extraction
        .bridges
        .iter()
        .map(|b| ((b.from_island.as_str(), b.to_island.as_str()), b.count))
        .collect();
    assert_eq!(
        bridges,
        BTreeMap::from([
            (("@fixture/api", "@fixture/shared"), 3),
            (("@fixture/cli", "@fixture/api"), 1),
            (("@fixture/cli", "@fixture/shared"), 1),
            (("@fixture/web", "@fixture/shared"), 3),
        ])
    );
}

#[test]
fn stand_in_fixture_roles_match_design_buildings() {
    let extraction = extract_repo(&fixture_root()).expect("extract stand-in fixture");

    let shared_entry = file(&extraction, "packages/shared/src/index.ts");
    assert!(shared_entry.roles.contains(&Role::EntryPoint));
    assert!(shared_entry.roles.contains(&Role::SharedUtility));
    assert_eq!(shared_entry.building, "keep");
    assert_eq!(shared_entry.importer_count, 7);

    let route = file(&extraction, "packages/api/src/routes/users.ts");
    assert!(route.roles.contains(&Role::ExposesEndpoints));
    assert_eq!(route.building, "sea_gate");

    let repo_file = file(&extraction, "packages/api/src/db/users-repo.ts");
    assert!(repo_file.roles.contains(&Role::DataAccess));
    assert_eq!(repo_file.building, "silos");
    assert_eq!(repo_file.importer_count, 2);

    let ui = file(&extraction, "packages/web/src/components/UserCard.tsx");
    assert!(ui.roles.contains(&Role::UiComponent));
    assert_eq!(ui.building, "market");

    let generated = file(&extraction, "packages/web/src/generated/api-client.ts");
    assert!(generated.roles.contains(&Role::Generated));
    assert_eq!(generated.building, "containers");

    let dead = file(&extraction, "packages/shared/src/dead.ts");
    assert!(dead.roles.contains(&Role::DeadCode));
    assert_eq!(dead.building, "ruin");
    assert_eq!(dead.importer_count, 0);

    // Entry points have no importers in the fixture but must not read as ruins.
    for entry in [
        "packages/api/src/index.ts",
        "packages/web/src/main.tsx",
        "packages/cli/src/index.ts",
    ] {
        let f = file(&extraction, entry);
        assert!(
            f.roles.contains(&Role::EntryPoint),
            "{entry} should be an entry point"
        );
        assert!(
            !f.roles.contains(&Role::DeadCode),
            "{entry} must not be dead code"
        );
        assert_eq!(f.building, "keep");
    }
}

#[test]
fn stand_in_fixture_json_round_trip_for_client() {
    let extraction = extract_repo(&fixture_root()).expect("extract stand-in fixture");
    let json = repo_city_server::extract::to_json(&extraction, true).expect("serialize");
    let value: serde_json::Value = serde_json::from_str(&json).expect("client-readable JSON");
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["is_stand_in_fixture"], true);
    assert_eq!(value["counts"]["files_parsed"], 12);
    assert_eq!(value["counts"]["resolved_imports"], 14);
    assert_eq!(value["counts"]["unresolved_imports"], 2);
    assert_eq!(value["unresolved"].as_array().map(Vec::len), Some(2));
    assert!(value["islands"].as_array().is_some_and(|a| a.len() == 4));
    assert!(value["bridges"].as_array().is_some_and(|a| a.len() == 4));
}

#[test]
fn directory_first_fallback_without_workspace() {
    let dir = std::env::temp_dir().join(format!("repo-city-dirs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("alpha")).expect("mkdir alpha");
    std::fs::create_dir_all(dir.join("beta")).expect("mkdir beta");
    std::fs::write(
        dir.join("alpha/a.ts"),
        "import { b } from '../beta/b';\nexport const a = b;\n",
    )
    .expect("write a");
    std::fs::write(dir.join("beta/b.ts"), "export const b = 1;\n").expect("write b");
    let extraction = extract_repo(&dir).expect("extract directory repo");
    let ids: Vec<&str> = extraction.islands.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["alpha", "beta"]);
    assert_eq!(extraction.counts.files_parsed, 2);
    assert_eq!(extraction.counts.resolved_imports, 1);
    assert_eq!(extraction.bridges.len(), 1);
    assert_eq!(extraction.bridges[0].from_island, "alpha");
    assert_eq!(extraction.bridges[0].to_island, "beta");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stand_in_single_package_python_and_feature_islands() {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample-single-package");
    let extraction = extract_repo(&root).expect("extract single-package fixture");
    assert!(extraction.is_stand_in_fixture);
    assert_eq!(extraction.counts.files_parsed, 9);
    assert_eq!(extraction.counts.total_imports, 8);

    assert_eq!(extraction.counts.resolved_imports, 6);
    assert_eq!(extraction.counts.unresolved_imports, 2);
    let island_ids: Vec<&str> = extraction.islands.iter().map(|i| i.id.as_str()).collect();
    assert!(
        !island_ids.iter().any(|id| id.ends_with("__init__.py")),
        "a package __init__ file must not become its own island: {island_ids:?}"
    );
    for expected in [
        "backend/app/modules/orders",
        "backend/app/modules/users",
        "frontend/src/features/orders",
        "frontend/src/features/users",
    ] {
        assert!(
            island_ids.contains(&expected),
            "missing island {expected}: {island_ids:?}"
        );
    }
    let main = file(&extraction, "backend/app/main.py");
    assert!(main.roles.contains(&Role::EntryPoint));
    assert_eq!(main.building, "keep");
    let router = file(&extraction, "backend/app/modules/users/router.py");
    assert!(router.roles.contains(&Role::ExposesEndpoints));
    assert_eq!(router.building, "sea_gate");
    let repo_file = file(&extraction, "backend/app/modules/users/repository.py");
    assert!(repo_file.roles.contains(&Role::DataAccess));
    let bridges: BTreeMap<(&str, &str), usize> = extraction
        .bridges
        .iter()
        .map(|b| ((b.from_island.as_str(), b.to_island.as_str()), b.count))
        .collect();
    assert_eq!(
        bridges.get(&("backend/app/modules/orders", "backend/app/modules/users")),
        Some(&1)
    );
    assert_eq!(
        bridges.get(&(
            "frontend/src/features/users",
            "frontend/src/features/orders"
        )),
        Some(&1)
    );
}

#[test]
fn workspace_repo_keeps_files_outside_packages() {
    let dir = std::env::temp_dir().join(format!("repo-city-ws-stray-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("packages/a/src")).expect("mkdir pkg");
    std::fs::create_dir_all(dir.join("tools")).expect("mkdir tools");
    std::fs::write(
        dir.join("package.json"),
        r#"{"name":"ws","private":true,"workspaces":["packages/*"]}"#,
    )
    .expect("write root pkg");
    std::fs::write(
        dir.join("packages/a/package.json"),
        r#"{"name":"@x/a","main":"src/index.ts"}"#,
    )
    .expect("write pkg");
    std::fs::write(dir.join("packages/a/src/index.ts"), "export const a = 1;\n")
        .expect("write index");
    std::fs::write(dir.join("tools/script.ts"), "export const s = 1;\n").expect("write stray");
    let extraction = extract_repo(&dir).expect("extract workspace with stray file");
    assert_eq!(
        extraction.counts.files_parsed, 2,
        "stray file must not be dropped"
    );
    assert!(extraction.files.iter().any(|f| f.path == "tools/script.ts"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn codex_regressions_nested_python_from_import_and_js_extension() {
    let dir = std::env::temp_dir().join(format!("repo-city-codex-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("pkg")).expect("mkdir");
    std::fs::write(dir.join("pkg/service.py"), "def run():\n    return 1\n")
        .expect("write service");
    std::fs::write(
        dir.join("pkg/__init__.py"),
        "from . import service\n\ndef load():\n    import missing_nested_xyz\n    return service\n",
    )
    .expect("write init");
    std::fs::write(
        dir.join("a.ts"),
        "import { s } from './service.js';\nexport const a = s;\n",
    )
    .expect("write a");
    std::fs::write(dir.join("service.ts"), "export const s = 1;\n").expect("write service ts");
    let extraction = extract_repo(&dir).expect("extract codex regression repo");
    // __init__: 1 resolved (service submodule); nested import counts as unresolved.
    let init = file(&extraction, "pkg/__init__.py");
    assert_eq!(init.import_count, 2);
    assert!(
        extraction
            .unresolved
            .iter()
            .any(|u| u.specifier == "missing_nested_xyz"),
        "nested python import must be counted: {:?}",
        extraction.unresolved
    );
    assert_eq!(
        file(&extraction, "pkg/service.py").importer_count,
        1,
        "from . import service must count service.py as imported"
    );
    let a = file(&extraction, "a.ts");
    assert_eq!(a.import_count, 1);
    assert!(
        extraction
            .bridges
            .iter()
            .flat_map(|b| &b.edges)
            .any(|e| e.to_file == "service.ts")
            || extraction
                .files
                .iter()
                .find(|f| f.path == "service.ts")
                .is_some_and(|f| f.importer_count == 1),
        "./service.js must resolve to service.ts"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn python_absolute_import_prefers_project_root_over_sibling() {
    let dir = std::env::temp_dir().join(format!("repo-city-pyroot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("pkg/sub")).expect("mkdir");
    std::fs::write(dir.join("pyproject.toml"), "[project]\nname = \"x\"\n").expect("write pyproject");
    std::fs::write(dir.join("config.py"), "VALUE = 'root'\n").expect("write root config");
    std::fs::write(dir.join("pkg/__init__.py"), "").expect("write pkg init");
    std::fs::write(dir.join("pkg/sub/__init__.py"), "").expect("write sub init");
    std::fs::write(dir.join("pkg/sub/config.py"), "VALUE = 'sibling'\n").expect("write sibling config");
    std::fs::write(dir.join("pkg/sub/mod.py"), "import config\n\nVALUE = config\n").expect("write mod");
    let extraction = extract_repo(&dir).expect("extract pyroot repo");
    assert_eq!(file(&extraction, "config.py").importer_count, 1);
    assert_eq!(file(&extraction, "pkg/sub/config.py").importer_count, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_root_is_an_error_not_an_empty_extraction() {
    let dir = std::env::temp_dir().join("repo-city-definitely-missing-xyz");
    assert!(extract_repo(&dir).is_err());
}

#[test]
fn empty_repo_yields_zero_counts_not_a_panic() {
    let dir = std::env::temp_dir().join(format!("repo-city-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let extraction = extract_repo(&dir).expect("extract empty repo");
    assert_eq!(extraction.counts.files_parsed, 0);
    assert_eq!(extraction.counts.total_imports, 0);
    assert!(extraction.islands.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
