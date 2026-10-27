# Repo City

**Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Meta × Cerebral Valley, Oct 26 – Nov 4, 2026).

Repo City manages AI agent sessions for a code repository as CRUD — with the repo rendered as a lightweight isometric archipelago. Every module is an island, every file a building whose shape says what it does (a keep for the entry point, a sea gate for exposed endpoints, silos for data, a lighthouse for a utility everything depends on, a ruin for dead code), and bridges are the imports between them. You open a repo and read what it does at plain sight. You send an agent on a quest to an island, watch its ship arrive and the windows light up where it works, and get a report in plain English. You can even drag a lane between two islands to start real work. The code is there when you want it, as drill-down — never as the main surface.

This is not a dashboard. It is a game-like world you operate: the map is the interface, and a slim command bar is the only panel.

## Status

Version 0.1.2. Design phase complete and approved; visual direction and sprite pipeline locked on 2026-10-26 (roadmap step 1). No application code yet.

- Roadmap: [ROADMAP.md](ROADMAP.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · Rules for coding agents: [AGENTS.md](AGENTS.md)
- Visual design system — the archipelago, building types, colors, type, and the sprite pipeline rules: [DESIGN.md](DESIGN.md)
- Sprite sheets and their generation briefs: [assets/](assets/) · Concept art: [docs/design/concepts/](docs/design/concepts/)
- Working pipeline prototype with live geometry checks: [prototype/sprite-spike/](prototype/sprite-spike/) (serve the repo root with `python3 -m http.server 8000`, then open `/prototype/sprite-spike/`)
- Approved design, committed contracts, and the full decision ledger: [specs/design.md](specs/design.md)
- Test plan: [specs/test-plan.md](specs/test-plan.md)
- Hackathon rules and submission requirements: [specs/hackathon-rules.md](specs/hackathon-rules.md)
- Everything needed to work on this, in one place: [notes/working-notes.md](notes/working-notes.md)

## Planned shape

One Rust binary (Axum) that scans a TypeScript/JavaScript or Python repo (Oxc for TS/JS, a Python parser for Python — Python added 2026-10-26 for single-package repos), builds directory-first islands and import bridges, manages agent sessions in git worktrees, and serves a PixiJS isometric map client. The art is generated low-poly sprite sheets, placed on the map by measurement (footprint plates, a grid-fitted tile set, an occupancy grid) and checked automatically for overlap, gaps and cropping. Agent sessions run through existing coding-agent CLIs behind one normalized event contract; a filesystem watcher is the ground truth for what each agent actually touched. Meta AI models (Llama) name the districts, explain the connections, and turn diffs into plain-English reports.

Highlights of the design:

- Session CRUD as quests: create, inspect, pause/resume, stop, archive from the command bar — one worktree per session
- An island lock, so two agents never work the same place at the same time
- One real drag action: draw a lane between two islands and, after an editable confirmation, an agent does the work
- A guarded finish flow: nothing merges without an explicit Accept, and conflicts stay visible
- Honesty by construction: workers move only on real events, unknown locations are marked unknown, and every report is generated from the real diff

## Submission

Meta Global AI Developer Hackathon — submit by **Nov 4, 9:00 PM ET** on the Cerebral Valley platform, with a 3-minute demo video and this public repo. Judging: Impact 30%, Use of Meta AI tooling 25%, Technical depth 20%, Demo 25%.
