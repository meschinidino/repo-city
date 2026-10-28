# Changelog

All notable changes to Repo City. Versions follow the `VERSION` file.

## [Unreleased]

### Changed — docs sync (2026-10-27)
- Fixed dead doc claims found in a doc audit: README no longer says "no application code yet" (it says step 4 of 8, version 0.2.0); AGENTS.md lists the real test commands; ROADMAP marks step 3 done and step 4 in progress with T5 done; DESIGN.md, `specs/design.md` and `specs/test-plan.md` record the approved command-bar variant A; `specs/step4-plan.md` status matches its decisions; working notes carry a dated update for the 60-island counts. Released changelog entries were not touched.
- Note for the canonical copies: `specs/design.md` and `specs/test-plan.md` were edited in the repo. Their canonical copies in `~/.gstack/projects/meta-hackathon/` need the same edits.
### Changed — map visuals (owner order: coast, cliffs, shape; on `feat/map-visual-fixes`, not merged)
- Step 1: the city renderer now uses the spike coast autotiling (`map/coast.ts`): every land cell picks its fitted coast tile from its water neighbors. The hand-drawn sand ring is gone.
- Step 2: code-drawn rock cliff faces under the two front shore edges of every shore cell.
- Step 3: islands get an organic outline (noise minus radial falloff, two smoothing passes, largest landmass, holes filled, seed from the island id, one-cell shore margin). Occupied plot cells are forced to land, so a cut never takes a building.
- Test-only islands are compact islets (3x2 plots max) with one pennant and a test count in the label. `backend/tests` (103 files) no longer takes the most land on the map.
- Bridges use D-zoom: at map zoom only pairs with 15+ imports draw as decks (24 of 381 pairs, 41% of imports on GestiKo). At island zoom all pairs draw. Chevrons are gone; direction is a moving pulse on the span at island zoom. This departs from the DESIGN.md stillness rule and is flagged in the PR for the owner.
- Owner round 2: cliffs only where the land behind the shore is thick (thin shores stay beach); trees on free inner land cells (no mountain sprite exists in the sheets; a mountain sheet is future sprite-pipeline work); smarter placement: strongest island takes the centre, each next island takes the best free spot near its neighbours, with seeded jitter.
- Numbers: Vitest 63 pass, tsc clean, Playwright 3 pass.
- Owner round 3: buildings inside an island are arranged, not row-major. The landmark kind (keep, then silos, sea gate, lighthouse) takes the centre plot; the rest, most common kind first, take the free plot with the fewest same-kind neighbours. Cottages vary: one in three takes the slate roof, by file hash. Vitest 65 pass.
- Owner round 4: strong bridges (15+ imports) now draw with the new bridge sprite (`assets/sprites/bridge.png`, owner pick run 1; brief in `assets/briefs/bridge.txt`). Weak pairs keep slim lines, so the sea stays open and there is no bridge carpet. Direction pulses are now a glow that runs on the deck itself, importer toward imported, strong decks only. New gold anchor cursor (`client/public/cursor.png`, owner pick run 1) for the canvas and the button. Island meaning text: left for its roadmap step, by owner decision. Vitest 65 pass, tsc clean.
- Owner round 5: bridge segments stepped at the joins (owner screenshot). Fix: the bridge art was levelled (deck axis horizontal) and cut to one post-to-post tile unit; each span is now one TilingSprite turned to the span angle, so the deck is one aligned piece. Direction is now sprite frames, not code dots: three glow frames (`assets/sprites/glow-0..2.png`) alternate on a glow sprite that travels the deck. Cursor did not change for the owner at 64 px; it is now 32 px (some browsers ignore larger cursor images) with the hotspot on the tip.
- Owner round 6: three bridge faults. Some decks were upside down (turn past 90°): the turn is now kept within half a circle of flat, so rails always stand up. Weak pairs drew as brown lines that are not bridges: weak pairs now draw nothing (only the 24 strong pairs are bridges; as decks the weak pairs made a lattice, tried and cut). Steep spans read as falling: spans now run straight only near a map axis, else as two legs along the two map axes, and the glow follows the same path.
- Owner round 7: bridges still looked odd at a direction change (owner screenshot). Two fixes. New asset for the other direction: `assets/sprites/bridge-b.png` (brief `assets/briefs/bridge-b.txt`, generated from run 1 as reference, levelled and cut to a post-to-post tile like `bridge-a.png`); each leg picks the tile for its screen direction. And spans now prefer a straight bridge along one map axis when the island rectangles overlap on the other axis (`bridgeAxisLegs`, tested): most bridges never bend; the bent path is only the fallback, and the glow follows the same points.
- Owner round 8: some bridges looked badly scaled or cropped (owner screenshot). Cropped: spans end at the island rectangle, but the organic shore sits inside it, so an exact deck end floats in open water. Decks now run 1.1 cells past the shore points and bury under the land tiles; the glow keeps the true shore points. Scaled: deck height came from a projected width and changed with direction. Every strong deck now gets one height from its import count (44 + 3·log2(count+1), capped 62 world px), same in both directions.
- Owner round 9: bridges went under terrain, and some looked duplicated (owner screenshots). Under terrain: the 1.1-cell bury was too deep and rectangle ends were the wrong shore. Each end now walks to the island's real land cells and stops 0.25 cells out; decks bury only 0.3 cells. Duplicated: both tiles carried the near posts' feet below the deck, a strip that read as a second thin bridge. Both tiles are cropped at 88% height; the strip is gone.


### Added — T5 session lifecycle (step 4, server first)
- New routes: `POST /api/sessions/{id}/pause`, `/resume`, `/archive`, and `/follow-up`. Bad moves fail with 409 (for example resume on a stopped session); unknown sessions give 404.
- A spawned session now works in a git worktree under the user home (`.repo-city/worktrees/<id>`) on branch `repo-city/<id8>`. The agent does not edit the user checkout, and the worktree does not pollute the user git status. Worktree create and remove have tests on a real git repo. A non-git repo gives an honest error.
- Pause kills the agent process and the watcher. It does not emit a finish event. Resume restarts the watcher and, if a CLI session id exists, respawns with `claude --resume <id>`. Follow-up works only on a finished or failed session with a CLI session id.
- Island lock: one working or paused session per island in one repo. A second create on the same island gives 409. Stop, finish, fail, and archive release the lock.
- Cap: at most 3 running spawned quests. A fourth spawn gives 409 and names the running quests.
- Tests: cargo 39 pass (was 31), clippy clean. The lifecycle tests use real HTTP with `spawn=false`. They do not test a real Claude process. That part is not yet proven live.


Roadmap steps 3 and 4 (in progress). Not yet a release.

### Added — server (T3/T4 + server core)
- Normalized event enum frozen (design D4) in `server/src/events/`: session started, file touched (path, change kind), command run, test result, agent message, session finished (completed/failed/stopped), each tagged with its source (cli, watcher, system). Stored events carry a global id and a gapless per-session `seq`. Free-text fields are redacted before storage (env-value matching plus token shapes, `events/redact.rs`); a cargo test asserts a planted secret never reaches SQLite.
- SQLite store in `server/src/store/` (rusqlite, D3): session CRUD and the append-only event log, with replay by per-session `seq` and by global id for WebSocket reconnects.
- Filesystem watcher in `server/src/watch/` (T4, D8): `notify` plus `git status`, 300 ms debounce, paths repo-relative, atomic-write temp files dropped. The watcher is ground truth for file touches; CLI events carry intent only. A cargo integration test edits a file the way a shell would (no CLI event names it) and asserts the touch still lands in the log.
- Claude Code adapter in `server/src/adapters/claude.rs` (T3, primary): translates `claude -p --output-format stream-json` into the enum; unmapped CLI events are counted, never passed raw. Recorded fixtures under `server/tests/fixtures/cli/` are labeled simulated and prove translation only.
- Axum server (`repo-city-server` binary, `--port`/`--db`): `GET /health`, `GET /api/extraction?path=`, session create/list/get, per-session events, `POST /api/sessions/{id}/stop`, `GET /api/sessions/{id}/report`, and `GET /ws` (replay after `since_id`, server-paced at one event per 50 ms after the first, then live). Creating a session with `spawn: true` and a task runs the Claude adapter in the repo; otherwise the session is watcher-only.
- English report from the real diff in `server/src/report.rs`: deterministic template from `git diff` (`generated_by: "template_from_diff"`, the approved Llama-unavailable fallback). When git cannot answer, the report endpoint returns `available: false` with the raw event list, never a polished fake.

### Added — client (Lane B)
- `client/src/events/`: the same contract in TypeScript plus a pure reducer — the ship docks on mapped file touches, stays at the gate marked location unknown on unmappable ones, test pennants and finish outcomes land on the view, replay duplicates are ignored. Vitest covers it with simulated events, labeled as such. Not yet wired into the Pixi renderer (T7).

### Live spike numbers (real, not simulated)
- Two live runs through the server (`spawn: true`, real Claude Code CLI, one-file task in a throwaway git repo): the watcher denominator was 1 real file change; the Claude adapter mapped 1/1 files (bar: 80%) and 1/1 session outcomes (bar: 100%), the CLI session id was stored, and the template report landed from the real diff (+1 -1). Translation fixtures remain simulated; these two runs are the live evidence.
- Extraction over HTTP against the real GestiKo clone: 600 files parsed, 43 islands, 234 bridges — matching the T13 counts. Import totals moved since the older working-notes snapshot (5,719 total / 3,024 resolved / 2,695 unresolved now); the clone or the extractor changed since that snapshot, the file/island/bridge counts did not.

### Changed — client follow-ups (from the 2026-10-26 handoff)
- The tile-overlap test was tautological (it asserted a literal `0` constant). Replaced by a measurement in `client/src/map/tileOverlap.ts`: the fitted tiles are composited on the renderer's grid offsets and pixels covered by two top faces are counted, sweeping every (tile, east, south) triple coarse then re-measuring the worst candidate fine. Measured on the committed sheets: 0.130% of top-face pixels (edge slivers from the fit's 1.02 growth). DESIGN.md sets no numeric level for this check, so the test asserts a 0.5% regression bound and prints the measured value every run.
- Layout failures now gate the render. The fail-level check list moved from `client/src/main.ts` into `renderGateFailures` in `client/src/map/pipeline.ts` so tests exercise the exact list the page enforces, and a building that found no place (`layout.failed`) is now on it: the page names the failure and does not render. A Vitest proves the gate trips on a forced layout failure; the committed world passes it, and the 2 Playwright smokes still pass.

### Added — client (T7 first slice) and server CORS
- City mode (`?repo=<path>`): the client now renders a real repo — islands, buildings typed by role, and bridges from the server's extraction — instead of only the three-island test map. `client/src/city/` holds the extraction types, the shelf-packed island layout (frozen, one 2×2 plot per file), the Pixi renderer, and the live client (extraction fetch, session create/stop, WebSocket, report). The existing event reducer drives it: the ship docks on watcher-confirmed touches, lit buildings glow, unmappable touches show the location-unknown ring, test pennants and the construction overlay follow events, and the English report card appears when a session finishes (or via Stop & report).
- The Rust server now sends permissive CORS headers; without them the browser blocked every cross-origin API call from the Vite client.
- New tests: Vitest layout checks (every file placed once, islands disjoint), and a Playwright gate journey (`client/e2e/city.spec.ts`) against real processes: fixture repo -> 4 islands in the browser -> a filesystem edit lights the building and docks the ship -> Stop -> template report from the real diff. The journey spawns no agent and says so in its name.
- **Day-3 kill gate: passed manually in-session (2026-10-27), real Claude Code agent**: one repo, one spawned session watched in the browser — CLI session id recorded, ship docked on the edited file, building lit, session finished, report card in the page read "Changed 1 file (+1 -1 lines)". Live evidence, not a recording; the committed journey above covers the same path minus the agent.
- GestiKo render measured: 43 islands, 600 buildings, canvas 5760×2970. All 234 bridges drawn is visual clutter and island labels are small at full-map zoom — polish items for the design review, not gate blockers.
- `docs/paper-test-gestiko.md`: the owner paper-test kit (script, district answer key from the live extraction, blank outcome record). **Not run**: it needs the GestiKo owner in person, and no retelling outcome is claimed until it happens.

### Review fixes (cross-model, Claude Opus 5.5 — Codex quota exhausted)
- Two review rounds over this branch fixed, among others: broadcast ordering (append+broadcast under one lock; WebSocket lag recovers from SQLite), stop actually killing the agent and never resurrecting a stopped session, CLI touches demoted to intent in the client (watcher alone moves the ship, D8), token-shape redaction requiring a word boundary (`task-runner`, `risk-free` survive), session tasks redacted before storage, watcher churn cap and directory filtering, the `git status` backstop seeded with pre-existing dirt and deduped against notify, rename-safe status parsing, and binary files no longer reported as new. Each fix carries a regression test.

### Changed — extractor (owner feedback on the design review, 2026-10-27)
- Parent islands no longer pose as modules. An island that contains other islands (backend holds `backend/app/modules/*`) is a container; the files no child claimed are now split by their next directory (`split_parent_remainders` in `server/src/extract/mod.rs`): `backend/tests` 103, `backend/alembic` 68, `frontend/tests` 57, `backend/app/integrations` 19, and so on. Empty parents are not listed. GestiKo: 600 files, **60 islands, 381 bridges** (was 43/234; bridges rise because former intra-backend edges now cross real islands). Paper-test answer key updated in `docs/paper-test-gestiko.md`.
- Test files are not buildings (DESIGN.md): a new `Test` role classifies files under test/tests/__tests__/e2e directories, `test_*`/`*_test` stems, and `.test.`/`.spec.` names as `pennant` instead of cottages/ruins. GestiKo: 165 pennants; the client draws them as small sand flags on poles, not houses.

### Changed — design review (2026-10-27, against DESIGN.md)
- City bridges now run shore-to-shore: the centre-to-centre line is clipped out of both islands (`bridgeSpan` in `client/src/city/layoutCity.ts`, unit-tested), so a bridge no longer crosses the land it connects. Width cap 6px, alpha 0.55 (was 10px/0.8).
- City islands get a shoreline: shallow-water halo (sea-shallow, 40%) and a sand edge ring drawn in code under the tiles, as DESIGN.md specifies. Before, city islands were bare grass rectangles with no coast.
- The city has a geometric camera (semantic zoom-level switching remains T12): the renderer fills the viewport, wheel zooms to the cursor (fit×0.9 to fit×8), drag pans, double-click refits. Measured on GestiKo (43 islands, 600 buildings): fit scale 0.281 (island labels at 5.6 CSS px, illegible) → zoomed 1.187 (labels at 23.7 CSS px, readable). Before, the canvas was letterboxed at 5120×2650 world size scaled by CSS with no way to zoom.
- Shell tokens aligned to DESIGN.md: page title is "Repo City" (was "sprite pipeline (T11)"), the Stop & report button uses the button radius (6px) and on-primary text color, and floating surfaces carry the specified offset shadow. Lit-building and pennant colors now use the exact token hexes (window-lit, success).
- Deferred from this review (recorded, not fixed): command bar/quest log/report card are step 4 (T12) and still specified-but-unbuilt in DESIGN.md; building-type distribution on GestiKo is extractor data (ruin 181, lighthouse 142, market 130 of 600) and reads repetitive at map zoom, which is the map-zoom housing-mass question for T12, not a renderer bug; no `prefers-reduced-motion` handling yet.

### Known gaps
- No Codex fallback adapter yet (T3 second half); no worktrees, district locks, or pause/resume (T5); the permission bridge is only the spike default `acceptEdits` inside the session repo (T8 owns the real bridge, with `/cso` before it merges).
- The client does not yet render extraction islands or consume the WebSocket (T7 first slice); the day-3 kill gate is therefore not yet passable end to end in the browser.
- `SessionStarted` is emitted twice per spawned session (once by the system at create, once by the CLI init carrying its session id); the client reducer already tolerates it.


## [0.2.0] - 2026-10-26

Scope amendment (2026-10-26): single-package repos and Python extraction. The available real repo (GestiKo) is one TS frontend package plus a Python backend in a single repo, not a TS monorepo; without this change it produced one island and no bridges and there was no real repo for the demo. Recorded as an amendment in `specs/design.md` and task T13 in `specs/tasks.jsonl`; `ROADMAP.md`, `AGENTS.md` and `notes/working-notes.md` updated to match. Go extraction deferred to the end of the hackathon only if time remains; multi-repo stays out of scope. T13 implemented: Python import extraction (`rustpython-parser`) and single-package feature/module districts in `server/src/extract/`, with a hand-counted single-package fixture (9 files, 8 imports, 6 resolved, 2 unresolved) in `server/tests/`. Real-repo run on GestiKo: 600 files, 43 islands, 232 bridges, 0 parse errors.

T11: sprite pipeline ported from the prototype into the client.

### Added — client (T11)
- `client/`: Vite + TypeScript + PixiJS client scaffold (Vitest for tests). Run it with `npm --prefix client run dev`; `?full=1` renders at 200 px per tile.
- `client/src/map/`: the pipeline as small pure functions — magenta and cyan keying, cut-out by connected shape, plate measurement and footprint choice, tile fitting, coast autotiling, occupancy layout with trees, code-drawn bridges and lanes — plus the Pixi renderer for the same three-island test map. Sheets load from `assets/sprites/`.
- `client/src/map/pipeline.test.ts`: every check from the prototype's checks table as a Vitest test against the committed sheets, at the pass levels in `DESIGN.md`. The same fail-level checks gate the render at load in the client.
- `client/e2e/smoke.spec.ts`: first Playwright E2E smoke (run with `npm --prefix client run test:e2e`, browser via `test:e2e:install`). It starts the Vite dev server itself, asserts the fail-level checks pass in the page, the three islands (api, auth, payments; 17 buildings, 15 trees) render with real sea/grass/sail pixels in the screenshot, no console errors, and the `?full=1` canvas is exactly 4200×2440 (200 px per tile). The five user journeys in `specs/test-plan.md` remain unimplemented until the session features they drive exist.

### Changed
- Tile fitting now straightens tile edges after the affine warp (per-column shift by the smoothed residual to the exact diamond). Measured on the committed sheets: the prototype's pre-fit edge error reproduces at 1.394% of tile width; the fitted tiles measure 0.25% worst, under the 1% target in `DESIGN.md`. Both numbers print in the test run.

Roadmap step 2, task T2: the Oxc extraction spike. First application code, tested first with a stand-in fixture; T13 (scope amendment above) later ran extraction on the real repo.

### Added — server (T2)
- `server/`: Cargo project (`repo-city-server`) with the extraction library in `server/src/extract/` and a `repo-city-extract` CLI. It scans a TS/JS repo with `oxc_parser` / `oxc_resolver` and outputs a client-readable JSON summary (`schema_version` 1): directory-first islands (workspace packages, or top-level directories without a workspace), import bridges counted per island pair, per-file roles/building types from DESIGN.md (keep, sea gate, silos, lighthouse, market, containers, ruin, cottage), and parsed/resolved/unresolved import counts with unresolved specifiers and parse errors listed.
- `server/tests/fixtures/sample-monorepo/`: small stand-in TS monorepo fixture (4 packages, 12 files), labeled a stand-in in its README, in test names, and in the JSON output (`is_stand_in_fixture`). Hand-counted expectations: 16 imports, 14 resolved, 2 unresolved, bridges api->shared 3, web->shared 3, cli->shared 1, cli->api 1.
- `server/tests/extraction_fixture.rs` plus unit tests: `cargo test` checks the counts, islands, bridges, roles, JSON shape, the directory-first fallback, and the empty-repo case (11 tests). `cargo clippy --all-targets -- -D warnings` is clean.

### Changed
- `specs/design.md` (and its canonical `~/.gstack` copy): T2 checkbox marked done.
- `VERSION` bumped to 0.2.0.

### Known gaps
- Workspace glob shapes beyond `packages/*`, external `node_modules` dependencies, dynamic `import()`, and scale (~2,000 files) remain unmeasured (T13 measured GestiKo at 600 files).
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
