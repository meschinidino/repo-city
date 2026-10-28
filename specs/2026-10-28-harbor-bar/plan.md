# T12 — Harbor bar (command bar, quest log, report card)

Date: 2026-10-28. Roadmap step 4, second half. Decisions are already
made in [../step4-plan.md](../step4-plan.md) (D-cap, D-create, D-open,
D-tokens, D-mobile, D-card-actions, D-report-place; variant A
"Harbor bar" approved 2026-10-27). T5 (server lifecycle) is merged.
This spec does not re-open those decisions.

## Objective

The bottom of the screen becomes the command center from the
approved mock: one token per agent session, a quest log above the
bar for create/pause/resume/stop/archive/follow-up, and the report
card beside its island. The map stays the first thing seen.

## Scope

- Harbor bar: New quest button, one token per session of the open
  repo (max 3 active: working or paused), status line, Stop & report
  for the primary session (kept from the live loop).
- Quest log panel: create form (plain-English quest, target island
  by map click or list, agent choice), per-session actions
  (pause/resume/stop/archive, follow-up), cap state at 3 active
  quests (create disabled, running quests named).
- Report card: report text beside the session's island with a
  leader line, clamped to the viewport; the honest line "Finish
  flow arrives in step 5" (D-card-actions). No inert buttons.
- Empty bar = repo opener when no repo is open (D-open).
- CSS variables from the DESIGN.md tokens for all floating
  surfaces (D-tokens); compact layout under 720px (D-mobile).

## Out of scope

- Accept/Discard/Keep (step 5, T6). Codex agent choice (adapter
  not built; the form offers the Claude agent or watcher-only, in
  plain words). Island meaning text (owner deferred it). Drag-
  connect (step 6). A second WS stream per session: the map's
  ship and lights keep following the primary session, as today.

## Architecture

- `client/src/city/live.ts`: `fetchSessions`, `sessionAction`
  (pause/resume/stop/archive/follow-up) on the T5 routes.
- `client/src/city/bar.ts`: the bar and quest log DOM, token
  rendering, cap and label helpers (unit-tested).
- `client/src/city/renderCity.ts`: `islandAtScreen` (click pick),
  `selectIsland` (lane-gold ring), `islandScreenPos` (card anchor).
- `client/src/main.ts`: wiring; the existing single-session event
  flow (ship, lights, status, stop & report) is unchanged.
- `client/index.html`: bar/quest-log/report-card DOM and the CSS
  variable theme.

## Risks

- The day-3 e2e journey is a contract: `#status` text, `#stop-report`,
  `#report`, the auto-created primary session. All keep working.
- Server states are working/paused/stopped/finished/failed/
  archived; the UI must show them in plain words, never invent one.
