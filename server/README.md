# Repo City server — T2 extraction spike

Rust crate for Repo City. Extraction tasks (T2, plus T13 for single-package districts and Python) only: no Axum server,
no adapters (T3), no permission bridge (T8). Those wait for the T1 rule check.

## What it does

`extract_repo(root)` walks a TypeScript/JavaScript/Python repo, parses every
source file with `oxc_parser` (TS/JS) or `rustpython-parser` (Python),
resolves import specifiers, and produces a JSON summary the client can read:

- directory-first islands (workspace packages from the root `package.json`,
  feature/module directories inside a single package, or top-level
  directories when neither applies),
- import bridges between islands, counted per island pair,
- per-file roles for the building types in `DESIGN.md` where the parse can
  tell (entry point, exposes endpoints, data access, UI component,
  shared utility, generated/vendored, dead code with no importers, ordinary),
- counts of files parsed, total / resolved / unresolved imports, with the
  unresolved specifiers listed and parse errors listed (never skipped).

## Run it

```sh
cargo run --bin repo-city-extract -- <repo-path>
cargo run --bin repo-city-extract -- <repo-path> --out summary.json
cargo run --bin repo-city-extract -- <repo-path> --compact
```

## Test it

```sh
cargo test
```

Tests run against the stand-in fixture in `tests/fixtures/sample-monorepo/`
(labeled a stand-in everywhere it is used). They assert hand-counted values.
They prove extraction translation on the fixture only; they do not prove
anything about the real demo repo, which is not available yet.
