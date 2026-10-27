use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use repo_city_server::store::Store;

fn usage() -> &'static str {
    "usage: repo-city-server [--port <n>] [--db <file>]"
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut port: u16 = 8787;
    let mut db = PathBuf::from("repo-city.db");
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                let Some(v) = args.get(i) else {
                    eprintln!("{}", usage());
                    return ExitCode::from(2);
                };
                let Ok(p) = v.parse() else {
                    eprintln!("bad port: {v}\n{}", usage());
                    return ExitCode::from(2);
                };
                port = p;
            }
            "--db" => {
                i += 1;
                let Some(v) = args.get(i) else {
                    eprintln!("{}", usage());
                    return ExitCode::from(2);
                };
                db = PathBuf::from(v);
            }
            "-h" | "--help" => {
                println!("{}", usage());
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown argument: {other}\n{}", usage());
                return ExitCode::from(2);
            }
        }
        i += 1;
    }
    let store = match Store::open(&db) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("could not open store {}: {e}", db.display());
            return ExitCode::FAILURE;
        }
    };
    let app = repo_city_server::app::build_app(store);
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("could not bind 127.0.0.1:{port}: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "repo-city server on http://127.0.0.1:{port} (db {})",
        db.display()
    );
    match axum::serve(listener, app).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("server error: {e}");
            ExitCode::FAILURE
        }
    }
}
