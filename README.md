# Repo City

**Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Meta × Cerebral Valley, Oct 26 – Nov 4, 2026).

Repo City manages AI agent sessions for a code repository as CRUD — with the repo rendered as a living, lightweight isometric city. Districts are modules, buildings are packages and files, and roads are the connections between them. You open a repo and read what it does at plain sight. You start an agent on a district, watch it build, and get a report in plain English. You can even drag a road between two districts to start real work. The code is there when you want it, as drill-down — never as the main surface.

This is not a dashboard. It is a game-like world you operate: the city is the interface.

## Status

Design phase complete and approved. No application code yet.

- Approved design, committed contracts, and the full decision ledger: [specs/design.md](specs/design.md)
- Test plan: [specs/test-plan.md](specs/test-plan.md)
- Hackathon rules and submission requirements: [specs/hackathon-rules.md](specs/hackathon-rules.md)
- Everything needed to work on this, in one place: [notes/working-notes.md](notes/working-notes.md)

## Planned shape

One Rust binary (Axum) that scans a TypeScript/JavaScript repo with the Oxc parser, builds directory-first districts and import roads, manages agent sessions in git worktrees, and serves a PixiJS isometric city client. Agent sessions run through existing coding-agent CLIs behind one normalized event contract; a filesystem watcher is the ground truth for what each agent actually touched. Meta AI models (Llama) name the districts, explain the connections, and turn diffs into plain-English reports.

Highlights of the design:

- Session CRUD on the map: create, inspect, pause/resume, stop, archive — one worktree per session
- A district lock, so two agents never work the same place at the same time
- One real drag action: connect two districts and, after an editable confirmation, an agent does the work
- A guarded finish flow: nothing merges without an explicit Accept, and conflicts stay visible
- Honesty by construction: workers move only on real events, unknown locations are marked unknown, and every report is generated from the real diff

## Submission

Meta Global AI Developer Hackathon — submit by **Nov 4, 9:00 PM ET** on the Cerebral Valley platform, with a 3-minute demo video and this public repo. Judging: Impact 30%, Use of Meta AI tooling 25%, Technical depth 20%, Demo 25%.
