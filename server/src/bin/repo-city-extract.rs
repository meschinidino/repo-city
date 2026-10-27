use std::path::PathBuf;
use std::process::ExitCode;

use repo_city_server::extract::extract_repo;

fn usage() -> String {
    "usage: repo-city-extract <repo-path> [--out <file>] [--compact]".to_string()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut repo: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut pretty = true;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    eprintln!("{}", usage());
                    return ExitCode::from(2);
                };
                out = Some(PathBuf::from(value));
            }
            "--compact" => pretty = false,
            "--pretty" => pretty = true,
            "-h" | "--help" => {
                println!("{}", usage());
                return ExitCode::SUCCESS;
            }
            other if !other.starts_with('-') && repo.is_none() => {
                repo = Some(PathBuf::from(other));
            }
            other => {
                eprintln!("unknown argument: {other}\n{}", usage());
                return ExitCode::from(2);
            }
        }
        i += 1;
    }
    let Some(repo) = repo else {
        eprintln!("{}", usage());
        return ExitCode::from(2);
    };
    let extraction = match extract_repo(&repo) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("extraction failed for {}: {e}", repo.display());
            return ExitCode::FAILURE;
        }
    };
    let json = match repo_city_server::extract::to_json(&extraction, pretty) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("failed to serialize extraction: {e}");
            return ExitCode::FAILURE;
        }
    };
    if extraction.is_stand_in_fixture {
        eprintln!("note: scanned tree is a stand-in fixture, not the real demo repo");
    }
    eprintln!(
        "parsed={} imports={} resolved={} unresolved={} islands={} bridges={}",
        extraction.counts.files_parsed,
        extraction.counts.total_imports,
        extraction.counts.resolved_imports,
        extraction.counts.unresolved_imports,
        extraction.islands.len(),
        extraction.bridges.len(),
    );
    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(&path, format!("{json}\n")) {
                eprintln!("failed to write {}: {e}", path.display());
                return ExitCode::FAILURE;
            }
            eprintln!("wrote {}", path.display());
        }
        None => println!("{json}"),
    }
    ExitCode::SUCCESS
}
