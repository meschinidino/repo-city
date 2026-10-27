# Roadmap

From the approved design ([specs/design.md](specs/design.md)): its Next Steps, the ten-day plan, gates and tasks T1–T13, in order, plus the gstack skills to run at each point. Submission is due **Nov 4, 9:00 PM ET**. Cut order if late: polish → pause/resume → Louvain → overlap marker. Never cut: real event mapping, finish flow, failure states, English reports, drag-connect.

Lines marked **▸ gstack** are reminders for whoever is working (Dino, Claude Code or Muse Code). Run the skill at that point; type it as a slash command (for example `/review`).

## Every working session and every change

- **▸ gstack `/context-restore`** at the start of a session, **`/context-save`** at the end, so the next agent picks up where the last one stopped.
- **▸ gstack `/review`** on every branch before it merges (pre-landing review of the diff).
- **▸ gstack `/ship`** to cut a release: it merges the base branch, runs the tests, reviews the diff, bumps `VERSION`, updates `CHANGELOG.md`, pushes and opens the PR.
- **▸ gstack `/investigate`** when something breaks and the cause isn't obvious; **`/careful`** before destructive git or file operations.
- Honesty rules in [AGENTS.md](AGENTS.md) apply to every report: say what was simulated, stop on missing pieces.

## 1. Visual direction and sprite pipeline — done (v0.1.0, 2026-10-26)

- Moodboard gate passed: two moodboard rounds with votes, three rejected directions, concept art compared across Codex and Muse.
- Locked: a low-poly quest archipelago, Codex image generation for art, sprites placed by measured footprint plates on a grid-fitted tile set with an occupancy grid.
- Delivered: [DESIGN.md](DESIGN.md), the sprite sheets and briefs in [assets/](assets/), concept art in [docs/design/concepts/](docs/design/concepts/), the working pipeline prototype in [prototype/sprite-spike/](prototype/sprite-spike/), and [AGENTS.md](AGENTS.md) for handoff (v0.1.2).
- Ran: `/office-hours`, `/plan-eng-review`, `/design-consultation`.
- Carried forward: tile edge error 1.39% (target under 1%); command bar, quest log and report card not mocked yet.

## 2. Setup, rule check and day-1 spikes

Setup (Dino):
- Trust this folder in Muse Code, or it won't load `AGENTS.md`.
- Demo repo received: GestiKo (single-package TS frontend plus Python backend). T2 ran on a labeled stand-in fixture; T13 covers GestiKo.
- Confirm team size and name one owner per spike.

Work:
- T1 (done 2026-10-26): Official Rules accepted in the portal; Discord #office-hours asked about "Use of Meta AI tooling" (25%). Adapter code (T3) and the permission bridge (T8) are unblocked. Record the outcome in `docs/meta-tooling-rule.md` when writing it up.
- T2 (can start now): Oxc extraction — directory-first islands, import bridges, file roles for building types, parsed/resolved/unresolved counts. Done against a stand-in fixture.
- T13 (can start now): single-package districts (feature/module directories) and Python extraction, tested on GestiKo. Added 2026-10-26 because the available real repo is a single-package TypeScript frontend plus a Python backend, not a TS monorepo (amendment in specs/design.md). Go extraction only at the end of the hackathon if time remains; not committed scope.
- T11 (can start now): port the sprite pipeline from step 1 into the client; its geometry checks become Vitest tests and run at load; tile edge error under 1%.
- T3 (unblocked, T1 done): normalized event enum with the Claude Code adapter (primary) and Codex (fallback), held to the pass thresholds.
- T8 (unblocked, T1 done): permission bridge per CLI and secret redaction with the planted-secret test.
  - **▸ gstack `/cso`** on the permission bridge and redaction before it merges.
- Record labeled-simulated CLI event fixtures once the event enum is frozen, so the client can be built in parallel (lane B in the design doc).
- Paper-test the 3-minute story on the demo repo's owner: they must retell what the repo does in 20 seconds.

## 3. Live loop on the map (day-3 kill gate)

- Axum server, SQLite store, WebSocket event stream.
- T4: filesystem watcher plus `git status` as ground truth for file touches.
- T7, first slice: the Pixi client renders islands from the extraction with the T11 pipeline, a ship sails on session start, windows light on file touches, scaffolding on the building being edited.
- English report from the real diff when a session ends.
- Eval harness on pinned fixtures for Llama naming and reports, and for building-type classification (test plan [EVAL] paths).
- Gate: one repo, one session, directory islands, the ship and lights move only on real events, and the report lands. If it fails, cut visual fidelity, never the control loop.
  - **▸ gstack `/qa`** on the gate journey in the browser: open a repo, start a session, watch real events, read the report.
  - **▸ gstack `/design-review`** on the rendered map at full size against DESIGN.md.

## 4. Quests and the command bar (session CRUD)

- **▸ gstack `/plan-design-review`** first: the eng review approved a "city with districts"; review the archipelago plan's UI (command bar, quest log, report card, every empty, stalled and failed state) before building it.
- T12: mock the command bar, quest log and report card against DESIGN.md, then build them with their empty, stalled, failed and report-unavailable states.
  - **▸ gstack `/design-shotgun`** for mock variants, then **`/design-html`** to turn the chosen one into production HTML/CSS. The gstack designer needs an OpenAI API key (`~/.claude/skills/gstack/design/dist/design setup`); without one, generate mocks with Codex image generation the way the sprites were made (`assets/briefs/`).
- T5: worktree per session; create, pause (stop plus resume by session id), stop, archive; island locks; shared read-only dependencies.
- Quests in plain English, with the target island and model chosen at creation.
- Draft the 3-minute demo script now, so steps 5–8 build toward it.

## 5. Finish flow and failure states

- T6: guarded Accept (refuses a dirty main checkout, shows the target branch and test command, re-runs checks after merge), Discard, Keep for later.
- Stalled, crashed, failed-test and location-unknown states drawn on the map, with plain-English text.
  - **▸ gstack `/qa`** on Accept, conflict, Discard and each failure state.

## 6. Drag-connect (never cut)

- Drag a lane between two islands, confirm an editable quest, and an agent does the work; the lane becomes a bridge only once a real import exists. Import cycles are refused.
  - **▸ gstack `/qa`** on the drag journey: cancel, edit, confirm, cycle refusal.

## 7. Overlap, cache and performance

- Same-file overlap marker (the backstop behind island locks).
- T9: extraction and naming cache by content hash; the render budget checked at about 2,000 files (60 fps, under 500 MB).
- Zoom levels (landmarks and a housing mass at map zoom).
  - **▸ gstack `/benchmark`** for load time and bundle size (fps and RAM at 2,000 files are measured by hand per T9).
  - **▸ gstack `/health`** for a code-quality pass before polish.

## 8. Polish, demo and submission

- T10: one-command run from a clean clone.
  - **▸ gstack `/devex-review`** on the clean-clone run, the way a judge would try it.
- **▸ gstack `/design-review`** on the final map and UI, and **`/qa-only`** for a last bug report across all five journeys.
- **▸ gstack `/document-release`** so the README, DESIGN.md and docs match what shipped.
- Rehearse the exact 3-minute demo on the demo repo (GestiKo); record one live run, label anything sped up or cut on screen.
- Submit on the Cerebral Valley platform with every teammate listed, the video, and this repo verified in a logged-out browser.
- Bonus prizes: post the demo on X and submit the link (Most Viral, counted through Nov 8, 11:59 PM ET); share the gallery entry (Community Vote).
- **▸ gstack `/retro`** after submission.
