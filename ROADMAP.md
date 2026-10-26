# Roadmap

From the approved design ([specs/design.md](specs/design.md)): its Next Steps, the ten-day plan, gates and tasks T1–T10, in order. Submission is due **Nov 4, 9:00 PM ET**. Cut order if late: polish → pause/resume → Louvain → overlap marker. Never cut: real event mapping, finish flow, failure states, English reports, drag-connect.

## 1. Visual direction and sprite pipeline — done (v0.1.0, 2026-10-26)

- Moodboard gate passed: two moodboard rounds with votes, three rejected directions, concept art compared across Codex and Muse.
- Locked: a low-poly quest archipelago, Codex image generation for art, sprites placed by measured footprint plates on a grid-fitted tile set with an occupancy grid.
- Delivered: [DESIGN.md](DESIGN.md), the sprite sheets and briefs in [assets/](assets/), concept art in [docs/design/concepts/](docs/design/concepts/), and the working pipeline prototype in [prototype/sprite-spike/](prototype/sprite-spike/).
- Carried forward: tile edge error 1.39% (target under 1%); command bar, quest log and report card not mocked yet.

## 2. Rule check and day-1 spikes

- T1: read the Official Rules and settle what counts for "Use of Meta AI tooling" (25%) before any adapter code; decide Llama's and Muse's roles.
- T2: Oxc extraction on the demo repo — directory-first islands, import bridges, unresolved-import counts.
- T3: normalized event enum with the Claude Code adapter (primary) and Codex (fallback), held to the pass thresholds.
- T8: permission bridge per CLI and secret redaction with the planted-secret test.
- Get the vibe-coder friend's real repo and paper-test the 3-minute story on him.

## 3. Live loop on the map (day-3 kill gate)

- Axum server, SQLite store, WebSocket event stream.
- T4: filesystem watcher plus `git status` as ground truth for file touches.
- T7, first slice: the Pixi client renders islands from the extraction with the sprite pipeline from step 1 (checks run at load), a ship sails on session start, windows light on file touches, scaffolding on the building being edited.
- English report from the real diff when a session ends.
- Gate: one repo, one session, directory islands, the ship and lights move only on real events, and the report lands. If it fails, cut visual fidelity, never the control loop.

## 4. Quests and the command bar (session CRUD)

- Mock the command bar, quest log and report card against DESIGN.md, then build them.
- T5: worktree per session; create, pause (stop plus resume by session id), stop, archive; island locks; shared read-only dependencies.
- Quests in plain English, with the target island and model chosen at creation.

## 5. Finish flow and failure states

- T6: guarded Accept (refuses a dirty main checkout, shows the target branch and test command, re-runs checks after merge), Discard, Keep for later.
- Stalled, crashed, failed-test and location-unknown states drawn on the map, with plain-English text.

## 6. Drag-connect (never cut)

- Drag a lane between two islands, confirm an editable quest, and an agent does the work; the lane becomes a bridge only once a real import exists. Import cycles are refused.

## 7. Overlap, cache and performance

- Same-file overlap marker (the backstop behind island locks).
- T9: extraction and naming cache by content hash; the render budget checked at about 2,000 files (60 fps, under 500 MB).
- Bring tile edge error under 1%; zoom levels (landmarks and housing mass at map zoom).

## 8. Polish, demo and submission

- T10: one-command run from a clean clone.
- Rehearse the exact 3-minute demo on the friend's repo; record one live run, label anything sped up or cut on screen.
- Submit on the Cerebral Valley platform with every teammate listed, the video, and this repo verified in a logged-out browser.
