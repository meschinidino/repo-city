# Step 4 plan — quests, command bar, zoom semantics (T12 + T5 order)

Status: review done, 2026-10-27. The owner approved the decisions
below and picked variant A, "Harbor bar". T5 is built (PR #15).
T12 is next. One item stays deferred: the D-zoom threshold (pinned
in the map-visuals work from the GestiKo count distribution).

## Scope (ROADMAP step 4, specs T12/T5, DESIGN.md)

- Bottom command bar: one token per agent session (max 3), quest log
  above it (create/pause/resume/stop/archive/follow-up), report card.
- Quests in plain English with target island and model at creation.
- T5 behind it: worktree per session, pause = stop + resume by id,
  island locks, shared read-only deps.
- Bridge/zoom semantics carried from the 2026-10-27 owner feedback:
  the archipelago must read as islands in open water at map zoom.

## Screen hierarchy (map mode, city open)

1. The archipelago (the work itself; first thing seen).
2. The command bar (who is working, bottom edge, always visible).
3. The quest log / report card (only when opened).

All decisions are resolved below. One value stays deferred: the
D-zoom import-count threshold.

## Decisions

- D-zoom (owner, 2026-10-27): map zoom aggregates bridges — only
  pairs above an import-count threshold draw (slim, with count);
  at island zoom (past ~2x fit) every bridge draws with chevrons,
  and deck treatment is allowed there. Threshold value to pin in
  implementation against GestiKo's count distribution.
- D-report-place (owner, 2026-10-27): report card anchors beside
  its island with a leader line (clamped to the viewport), per
  DESIGN.md — not the fixed corner box.
- D-cap (owner, 2026-10-27): at 3 running quests the create form
  explains the cap and names the running quests; create stays
  disabled until one stops.
- D-create (owner, 2026-10-27): quest target = click the island on
  the map (lane-gold selection ring), name shown in the form; a
  list fallback serves keyboard users.
- D-open (owner, 2026-10-27): the empty command bar is the repo
  opener ("Path to a repo" + Open); URL parameters keep working.
  Bad paths reuse the QA-fixed refusal copy.
- D-mocks (owner, 2026-10-27): /design-shotgun variants of bar +
  quest log right after this review, judged against DESIGN.md
  tokens and the real GestiKo map, before any build.
- D-tokens (owner, 2026-10-27): T12 introduces CSS variables from
  the DESIGN.md front-matter tokens for all floating surfaces.
- D-mobile (owner, 2026-10-27): under ~720px, compact agent tokens
  (icon, name, state), quest log as a full-width sheet, 44px touch
  targets, keyboard focus in lane gold.
- D-order (owner, 2026-10-27): T5 session lifecycle first
  (worktrees, pause/resume, locks, server-tested), then T12 UI.
- D-card-actions (owner, 2026-10-27): in step 4 the report card
  shows the report plus a plain "Finish flow arrives in step 5"
  line — no inert buttons. Step 5 (T6) swaps in Accept/Discard/Keep.

Deferred: D-zoom's import-count threshold — pin during
implementation from GestiKo's bridge count distribution
(381 bridges; pick the cut that keeps open water at fit view and
prove it on the screenshot).

## GSTACK REVIEW REPORT

| Pass | Before | After | Remaining |
|---|---|---|---|
| 1 Information architecture | 4/10 | 8/10 | Mock will confirm bar/map hierarchy |
| 2 Interaction states | 5/10 | 8/10 | Follow-up failure copy at build |
| 3 Journey & emotion | 4/10 | 8/10 | First-run judged on the mock |
| 4 AI-slop risk | 6/10 | 7/10 | Until shotgun variants are judged |
| 5 Design-system alignment | 7/10 | 9/10 | CSS variables land with T12 |
| 6 Responsive & accessibility | 4/10 | 8/10 | Spec'd, unbuilt |
| 7 Decisions | — | 8 resolved, 1 deferred (threshold pin) | |

Overall design completeness: 5/10 → 8/10.
Status: DONE_WITH_CONCERNS (mocks are the next gate, not yet run;
cross-model outside voices not run — Claude Opus hit its session
limit on 2026-10-27, retry when it resets).
- D-mock-pick (owner, 2026-10-27): variant A "Harbor bar" approved
  from three generated mockups (designs/command-bar-20261027/).
  B (pennant tokens) and C (manifest) rejected.
