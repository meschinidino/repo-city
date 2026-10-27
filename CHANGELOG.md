# Changelog

All notable changes to Repo City. Versions follow the `VERSION` file.

## [0.2.0] - 2026-10-26

Scope amendment (2026-10-26): single-package repos and Python extraction. The available real repo (GestiKo) is one TS frontend package plus a Python backend in a single repo, not a TS monorepo; without this change it produced one island and no bridges and there was no real repo for the demo. Recorded as an amendment in `specs/design.md` and task T13 in `specs/tasks.jsonl`; `ROADMAP.md`, `AGENTS.md` and `notes/working-notes.md` updated to match. Go extraction deferred to the end of the hackathon only if time remains; multi-repo stays out of scope. T13 implemented: Python import extraction (`rustpython-parser`) and single-package feature/module districts in `server/src/extract/`, with a hand-counted single-package fixture (9 files, 8 imports, 6 resolved, 2 unresolved) in `server/tests/`. Real-repo run on GestiKo: 600 files, 43 islands, 232 bridges, 0 parse errors.

T11: sprite pipeline ported from the prototype into the client.

### Added
- `client/`: Vite + TypeScript + PixiJS client scaffold (Vitest for tests). Run it with `npm --prefix client run dev`; `?full=1` renders at 200 px per tile.
- `client/src/map/`: the pipeline as small pure functions — magenta and cyan keying, cut-out by connected shape, plate measurement and footprint choice, tile fitting, coast autotiling, occupancy layout with trees, code-drawn bridges and lanes — plus the Pixi renderer for the same three-island test map. Sheets load from `assets/sprites/`.
- `client/src/map/pipeline.test.ts`: every check from the prototype's checks table as a Vitest test against the committed sheets, at the pass levels in `DESIGN.md`. The same fail-level checks gate the render at load in the client.
- `client/e2e/smoke.spec.ts`: first Playwright E2E smoke (run with `npm --prefix client run test:e2e`, browser via `test:e2e:install`). It starts the Vite dev server itself, asserts the fail-level checks pass in the page, the three islands (api, auth, payments; 17 buildings, 15 trees) render with real sea/grass/sail pixels in the screenshot, no console errors, and the `?full=1` canvas is exactly 4200×2440 (200 px per tile). The five user journeys in `specs/test-plan.md` remain unimplemented until the session features they drive exist.

### Changed
- Tile fitting now straightens tile edges after the affine warp (per-column shift by the smoothed residual to the exact diamond). Measured on the committed sheets: the prototype's pre-fit edge error reproduces at 1.394% of tile width; the fitted tiles measure 0.25% worst, under the 1% target in `DESIGN.md`. Both numbers print in the test run.

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
