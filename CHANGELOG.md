# Changelog

All notable changes to Repo City. Versions follow the `VERSION` file.

## [0.2.0] - 2026-10-26

Roadmap step 2, task T2: the Oxc extraction spike. First application code.
Tested with a stand-in fixture only; the real demo repo is not available yet.

### Added
- `server/`: Cargo project (`repo-city-server`) with the extraction library in `server/src/extract/` and a `repo-city-extract` CLI. It scans a TS/JS repo with `oxc_parser` / `oxc_resolver` and outputs a client-readable JSON summary (`schema_version` 1): directory-first islands (workspace packages, or top-level directories without a workspace), import bridges counted per island pair, per-file roles/building types from DESIGN.md (keep, sea gate, silos, lighthouse, market, containers, ruin, cottage), and parsed/resolved/unresolved import counts with unresolved specifiers and parse errors listed.
- `server/tests/fixtures/sample-monorepo/`: small stand-in TS monorepo fixture (4 packages, 12 files), labeled a stand-in in its README, in test names, and in the JSON output (`is_stand_in_fixture`). Hand-counted expectations: 16 imports, 14 resolved, 2 unresolved, bridges api->shared 3, web->shared 3, cli->shared 1, cli->api 1.
- `server/tests/extraction_fixture.rs` plus unit tests: `cargo test` checks the counts, islands, bridges, roles, JSON shape, the directory-first fallback, and the empty-repo case (11 tests). `cargo clippy --all-targets -- -D warnings` is clean.

### Changed
- `specs/design.md` (and its canonical `~/.gstack` copy): T2 checkbox marked done.
- `VERSION` bumped to 0.2.0.

### Known gaps
- Not yet run against the real demo repo: workspace glob shapes beyond `packages/*`, external `node_modules` dependencies, dynamic `import()`, and scale (~2,000 files) are unmeasured.
- No Axum server yet; adapters (T3) and the permission bridge (T8) still wait for the T1 rule check.

## [0.1.3] - 2026-10-26

Roadmap now says what to do next and which gstack skill to run where. No application code yet.

### Changed
- `ROADMAP.md`:
  - New "every working session and every change" loop: `/context-restore` and `/context-save`, `/review` before every merge, `/ship` to cut a release, `/investigate`, `/careful`.
  - **▸ gstack** reminders at each step: `/cso` on the permission bridge, `/qa` and `/design-review` at the day-3 gate, `/plan-design-review` before the command bar, `/design-shotgun` and `/design-html` for its mocks (with the OpenAI API key caveat and the Codex fallback), `/qa` on finish, failure and drag journeys, `/benchmark` and `/health` in performance, `/devex-review`, `/design-review`, `/qa-only` and `/document-release` before submission, `/retro` after.
  - New items: setup tasks for Dino (trust the folder in Muse, get the friend's repo, confirm team size and spike owners); asking Discord whether building with Muse Code counts; T2 and T11 marked as startable now, T3 and T8 after T1; recorded event fixtures for the parallel client lane; the eval harness for naming, reports and building types; the 3-minute demo script drafted at step 4; the X post and gallery for the bonus prizes.
- `AGENTS.md`: tells agents to run the **▸ gstack** skills when they reach them and to report which ones they ran.
- `README.md`: version 0.1.3.

## [0.1.2] - 2026-10-26

Ready for handoff to another coding agent. No application code yet.

### Added
- `AGENTS.md`: shared rules for coding agents (Muse Code reads this file): what to read first, where to start (roadmap step 2, with T2 and T11 open before the T1 rule check and adapter work blocked until it), the honesty rules, design and sprite rules, docs sync, commands and git rules.

### Changed
- `CLAUDE.md` now points to `AGENTS.md` for the shared rules instead of repeating them, so both agents follow one file.
- `README.md` and `notes/working-notes.md` link to `AGENTS.md`.

## [0.1.1] - 2026-10-26

Planning docs brought in line with the visual direction. No application code yet.

### Changed
- `specs/design.md`: decision ledger entry R18 records the visual decisions D19–D23 (archipelago metaphor, command bar and quest log, building types by file role, Codex low-poly art, placement by rule), each with the user's own words as the source. New tasks T11 (port the sprite pipeline into the client, checks as tests, tile edge error under 1%) and T12 (mock, then build, the command bar, quest log and report card). T7, the live-loop diagram and "What already exists" updated for islands, ships and the v0.1.0 assets.
- `specs/test-plan.md`: journeys and edge cases rewritten for islands, quests, the command bar and report cards; new critical paths for motion following events only, sprite pipeline geometry, and building-type classification (eval); pending decisions now name the unmocked UI and Muse's role.
- `specs/tasks.jsonl`: T7 retitled; T11 and T12 added.
- `ROADMAP.md`, `notes/working-notes.md`, `specs/README.md`: task and ledger ranges updated to T1–T12 and D1–D23; T11 placed in step 3 and T12 in step 4.
- Canonical copies in `~/.gstack/projects/meta-hackathon/` updated first and re-copied, per the sync rule.

## [0.1.0] - 2026-10-26

Roadmap step 1: visual direction and sprite pipeline. No application code yet.

### Added
- `DESIGN.md`: the visual design system. Repo City is a low-poly quest archipelago: modules are islands, imports are bridges, agent sessions are ships with a token in a bottom command bar, and every file's building shows what it does (keep, sea gate, silos, lighthouse, market, containers, ruin, cottage). Includes color, type, spacing and component tokens, layout rules (full-screen map, command bar and quest log as the only panel), motion rules (nothing moves without a real event), and the sprite pipeline rules and checks.
- `assets/sprites/`: the generated sprite sheets the map is built from, on magenta with cyan footprint plates: `buildings.png` (keep, sea gate, silos, lighthouse, two cottages, containers, ruin, construction), `market-flags-trees.png` (2×1 and 3×1 markets, flags, nine trees and bushes), `coast.png` (grass tiles with beach on every edge combination), `ship.png`.
- `assets/briefs/`: the Codex image-generation briefs that produced each sheet and the concept art, so any sheet can be regenerated or extended. `assets/README.md` maps each sheet to its brief, its grid contents and the reference images used.
- `docs/design/concepts/`: the two approved concept images (map overview and an island close-up, low-poly).
- `prototype/sprite-spike/`: a working reference implementation of the pipeline in a single HTML page. It keys and cuts the sheets, fits tiles to the exact grid, places buildings from their measured plates on an occupancy grid, draws bridges and lanes in code, and reports 21 geometry checks. Run it from the repo root with `python3 -m http.server 8000`, then open `/prototype/sprite-spike/`.
- `ROADMAP.md`, `CHANGELOG.md`, `VERSION`, and a project `CLAUDE.md` that points agents at the working notes and `DESIGN.md`.

### Changed
- `specs/design.md` (and its canonical `~/.gstack` copy): visual direction marked decided; new "Visual Direction" section mapping contract terms to what is drawn (district → island, road → bridge, worker → ship); stale moodboard references updated. Contracts and the decision ledger keep their wording.
- `README.md`: describes the archipelago, building types, quests and the measured sprite pipeline; links to `DESIGN.md`, `ROADMAP.md` and this changelog.
- `notes/working-notes.md`: moodboard gate marked passed; visual direction added to the binding decisions; asset locations now point into the repo.

### Known gaps
- Tile edges wander up to 1.39% of a tile width against a 1% target (about 3 px at 200 px per tile).
- The command bar, quest log and report card are specified in `DESIGN.md` but not mocked yet.
- Moodboard reference screenshots are copyrighted store images and stay out of the repo; they are linked from private pages only.
