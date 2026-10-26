# Changelog

All notable changes to Repo City. Versions follow the `VERSION` file.

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
