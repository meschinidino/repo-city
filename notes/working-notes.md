# Working notes — Repo City

Everything needed to work on this project, in one place. If a note here conflicts with [specs/design.md](../specs/design.md), the design doc wins until it is edited. Chat language for this project: **English** (the hackathon is delivered in English).

## Where the plan lives

| What | Canonical location | Repo copy |
|---|---|---|
| Approved design doc (problem, premises, approaches, visual direction, committed contracts, D1–D23 decision ledger, implementation tasks T1–T13, GSTACK REVIEW REPORT) | `~/.gstack/projects/meta-hackathon/dinomeschini-unknown-design-20261026-151207.md` (Status: APPROVED) | [specs/design.md](../specs/design.md) |
| Test plan (5 E2E journeys, edge cases, critical paths) | `~/.gstack/projects/meta-hackathon/dinomeschini-unknown-eng-review-test-plan-20261026-160000.md` | [specs/test-plan.md](../specs/test-plan.md) |
| Machine-readable tasks | `~/.gstack/projects/meta-hackathon/tasks-eng-review-20261026-163341.jsonl` | [specs/tasks.jsonl](../specs/tasks.jsonl) |
| Hackathon rules | [specs/hackathon-rules.md](../specs/hackathon-rules.md) | same |
| Visual design system (archipelago, building types, tokens, sprite pipeline rules) | [DESIGN.md](../DESIGN.md) | same |
| Round-1 mockups (all rejected) | `~/.gstack/projects/meta-hackathon/designs/mockup-20261026/` (variant-A/B/C.png) | not copied |
| Archipelago concepts (Codex vs Muse) | `~/.gstack/projects/meta-hackathon/designs/archipelago-20261026/`; board with votes: https://claude.ai/artifact/MFR5D645P8mLhdiiXXzYNQ | not copied |
| Sprite sheets in use and their Codex briefs | `~/.gstack/projects/meta-hackathon/designs/sprites-20261026/` holds every round (the rejected ones too) | [assets/sprites/](../assets/sprites/), [assets/briefs/](../assets/briefs/) — the repo copies are what the build uses |
| Concept art (approved, low-poly) | `~/.gstack/projects/meta-hackathon/designs/archipelago-20261026/codex/` | [docs/design/concepts/](../docs/design/concepts/) |
| Sprite pipeline prototype | — | [prototype/sprite-spike/](../prototype/sprite-spike/) |
| Roadmap, changelog, version | — | [ROADMAP.md](../ROADMAP.md), [CHANGELOG.md](../CHANGELOG.md), [VERSION](../VERSION) |
| Rules for coding agents (Muse Code reads it; CLAUDE.md points to it) | — | [AGENTS.md](../AGENTS.md) |
| Moodboard v2 with votes | https://claude.ai/artifact/CFEghD36uSQxc51eoadZrE (private; reference screenshots are internal only) | not copied |
| Sprite spike with live checks | https://claude.ai/artifact/LBVcGZJPPyKJfaCbiHBxWB (private) | not copied |

**Sync rule:** when the `~/.gstack` design doc changes, re-copy it to `specs/design.md` in the same commit. The gstack skills read the `~/.gstack` copy; humans and judges read the repo copy.

## Binding decisions (index; full text in the design doc ledger)

- **Visual direction (2026-10-26): low-poly quest archipelago** — modules are islands, imports are bridges, agents are ships, a bottom command bar with a quest log is the only panel. Codex image generation makes the art; sprites are placed by measured footprint plates on a grid-fitted tile set with an occupancy grid. Full rules in [DESIGN.md](../DESIGN.md).
- Approach B: isometric city (rendered as the archipelago above). Node.js backend **rejected** by the user. **One Rust binary (Axum) serving a PixiJS/TypeScript client.** Tauri rejected.
- TS/JS extraction in Rust with **Oxc** (`oxc_parser`, `oxc_resolver`); Python extraction added 2026-10-26 for single-package repos (see the amendment in specs/design.md). dependency-cruiser/ts-morph are out with Node.
- SQLite via **rusqlite**: session state, append-only event log (per-session sequence), extraction cache keyed by file content hash.
- One **normalized event enum** in Rust. Adapters: **Claude Code CLI primary, Codex CLI fallback.** Adapter pass bar: ≥80% of file changes mapped to a building, 100% of session/test outcomes mapped (watcher is the denominator).
- **Filesystem watcher (`notify`) + `git status`** is ground truth for file-touched. CLI events carry intent/narration only.
- Districts are **directory-first**. Louvain clustering is a candidate refinement only, shipped only if it produces nameable districts on the real demo repo.
- **District lock:** a second session on a busy district is refused or queued, naming the busy session. Same-file overlap marker is the backstop.
- **Drag-connect is never-cut.** Cut order: polish → pause/resume → Louvain → overlap marker. Never cut: real event mapping, finish flow, failure states, English reports, drag.
- Pause = **stop + resume by stored session id** (`claude --resume <id>`, verified in the installed CLI). No process suspension.
- Accept is **guarded**: dirty main checkout refuses, target branch shown, test command discovered (`package.json` scripts → justfile → Makefile) and shown before running, checks re-run after every merge.
- Demo video: one live rehearsed task; sped-up/cut segments **labeled on screen**; nothing simulated is presented as live. Same rule inside tests: recorded CLI fixtures are labeled simulated and prove translation only.

## Gates, in order

1. **T1 — Meta AI tooling rule check, before any adapter code.** Read the Official Rules (accept in portal first), confirm what counts for the 25% criterion, which models qualify, and how Llama/Meta models are accessed. Ambiguity → Discord #office-hours. Llama must be visibly load-bearing in the demo: English reports, drag-connect task text, edge labels.
2. **Day-1 spikes** (one named owner each): Oxc extraction on the real repo (count unresolved imports), CLI event stream (both adapters, thresholds above), permission bridge (Claude permission modes/tool lists/prompt tool; Codex sandbox/approval modes — map each safety rule, downgrade any claim that cannot be enforced).
3. **Day-3 kill gate (narrowed):** directory districts only, one session, one repo, worker moves on real file events, English report lands. Roads may be partial. If it fails: cut visual fidelity, never the control loop or drag.
4. **Moodboard gate: passed 2026-10-26.** Moodboard v2 votes → quest archipelago → Codex over Muse for art → low-poly → four sprite spike rounds. See DESIGN.md. Still open: command bar and report card mockups; tile edge error is 1.39% against a 1% target.
5. **Submission gate:** CV platform entry with all teammates, 3-minute video, this public repo verified logged-out, all before **Nov 4, 9:00 PM ET**.

## Unverified premises (resolve at kickoff)

- Demo repo (corrected 2026-10-26): [GestiKo](https://github.com/juanmanuelaidar/GestiKo), a single repo with one TS frontend package and one Python backend — not a TS/JS monorepo. Measured at clone: 705 files (416 `.py`, 184 `.ts`/`.tsx`, single Vite/React package, no workspaces). T2 run before the Python amendment: only the frontend was extracted (184 files, 1,158 imports, 603 resolved, 555 unresolved — mostly external packages, because `node_modules` is not installed — 1 island, 0 bridges). Task T13 covers the fix: single-package districts and Python extraction, tested on GestiKo. Install size/time: not measured.
- Demo-repo scope decision (2026-10-26, user, refined same day): make extraction work on single-package repos like GestiKo (one frontend package + one Python backend in a single repo), and add Python extraction. Go is deferred to the end of the hackathon, only if time remains — it is not committed scope. This re-opens the design doc's "non-TS/JS extraction is out of scope" line for Python only; the amendment is recorded in `specs/design.md` (Amendment 2026-10-26), and the TS fixture mainline and all other tasks keep moving meanwhile. What "single-package support" means concretely: islands must work below package level (GestiKo's `frontend/src/features/*` and `backend/app/modules/*`), since a single-package repo otherwise yields one island and no bridges. Multi-repo support stays out of scope. Implemented in T13: run on GestiKo gives 600 files parsed (416 Python + 184 TS), 3,988 imports, 1,969 resolved, 2,019 unresolved (mostly external packages with no installed dependencies on either side), 43 islands, 232 bridges, 0 parse errors. Tested on a real repo for extraction counts only; the paper-test/retelling check with the repo owner is still open.
- Team size/capacity ("small team up to 4" is unconfirmed). Spike owners in gate 2 force this answer.
- Render scale at ~2,000 buildings (60 fps, <500 MB app-only on the demo machine) — measured at the day-3 gate (task T9), not before.

## The assignment (before building the renderer)

Moodboard: done (2026-10-26). Friend's repo: received (GestiKo, see the corrected premise above) but not usable as the demo repo yet — its Python backend is invisible to the extractor and its frontend yields one island today. Still to do: pick the actual demo repo (or scope GestiKo's frontend with feature-level islands), then paper-test the 3-minute story on its owner: open the repo, name three districts, narrate one agent task and its English report. He must retell what the repo does in 20 seconds. If he cannot, the district model is wrong, not the art.

## Tools and access already verified (2026-10-26)

- Claude Code CLI 2.1.293 at `~/.local/bin/claude` (user subscription). Verified flags: `-p --output-format stream-json`, `--resume <id>`, `--permission-mode`, `--allowedTools/--disallowedTools`, `--permission-prompt-tool`. Model used for second opinions: `claude-opus-5-5`.
- Codex CLI 0.160.0 at `/opt/homebrew/bin/codex` (user subscription). Verified: `codex exec --json`, `--skip-git-repo-check`, `-s/--sandbox`, approval routing. Model: `gpt-6-astra` (from `~/.codex/config.toml`).
- GitHub CLI logged in as `meschinidino` (repo scope, SSH protocol).
- Model credits/partners from the event page: Baseten $100, Modal $100, Fireworks $25 (select participants). Check #resources on Discord for credit forms.
- Second opinions on record (in the design doc): Claude Opus 5.5, Codex Astra, in-host agent. Do not re-run for settled questions.

## Implementation tasks (summary; full text in design doc)

T1 Meta rule check · T2 Oxc extraction with counts · T3 normalized events + adapters under thresholds · T4 watcher ground truth · T5 worktree lifecycle + district locks + shared read-only deps + SQLite · T6 guarded finish flow · T7 Pixi archipelago · T8 permission bridge + secret redaction (planted-secret test) · T9 cache + render budget · T10 one-command run from a clean clone · T11 sprite pipeline in the client (checks as tests) · T12 command bar, quest log and report card.

Test stack (approved): cargo test (Rust), Vitest (client logic), Playwright (the 5 E2E journeys), eval harness for Llama naming/report quality on pinned fixtures. User standard: useful coverage and branch tests, meaningful E2E — not percentage for its own sake.

## Honesty rules (standing, from the user)

- Never claim "verified" or "works end to end" if any part was simulated (mocks, fixtures, stubs). Label simulated evidence as simulated, up front.
- If something from the backend or environment is missing, stop and report it as a blocker: what is missing and what the user must do.
- Separate "tested with simulation" from "tested end to end" in every report.

## Updates (2026-10-27)

- GestiKo counts moved: 600 files, 60 islands, 381 bridges since the parent-remainder split (PR #13). Older counts in the 2026-10-26 entries are history, not current numbers.
- Command bar, quest log and report card are mocked. The owner approved variant A, "Harbor bar". T12 builds it. T5 (session lifecycle) is done (PR #15).

## Updates (2026-10-28, ribbon bridges, merged as PR #20)

- Bent bridges are procedural ribbons now (branch feat/ribbon-bridges): deckRibbon builds mitered strips per leg (bevel past 120° deflection), each leg in its direction plank tile, posts stamp along the strip edges with sagging rope rails. This supersedes the corner-piece sprite task (PR #19 still open, unmerged).
- Why not full bridge-a/b.png on the ribbon: both carry 20-30% transparent margins plus baked posts/ropes; full-sprite v maps transparency across miter seams. Fix: cropped pure-plank tiles (bridge-plank-a/b.png, A is B mirrored) plus a shaft-only post crop (bridge-post.png). Source crops documented in renderCity.ts; originals stay on disk.
- All 5 GestiKo elbows render clean miters (deck-only + furniture shots in /tmp/corner: v76/v167/v171/v251/v272, gal171). Gates green: cargo 28+8+13+1+3, clippy, Vitest 96, tsc, Playwright 5. Taste-check owed to the owner before any merge; Step 5 starts only after that pass.
- Opus review caught a P0: the strip triangle diagonal ran along the left edge, leaving a water hole along every right rail (visible only close up; full review in /tmp/corner/opus-review.txt). Fixed with the startR->endL diagonal plus a quad-coverage test, a butt fallback for short legs and 180° reversals, a Mesh geometry leak fix, rope sag 3px true, typed postRanges, deckEdges extracted pure with tests. Re-verified: hole centroid renders deck (holetest.png), all joints re-shot (w76/w167/w171/w251/w272, gal2, k171). Gates green: Vitest 106, rest unchanged. Rejected with reasons: u-restart per leg (breaks rail phase), depth sort and 180° texture flip (deferred, no visible defect), end posts on grass (intended bridgeheads).
## Updates (2026-10-29)

- Step 5 done (PR #21 open, merge on owner pass): guarded Accept (base branch recorded at creation, dirty/off-target/mid-merge refusals, uncommitted work committed on the quest branch first, `--no-ff` merge, post-merge checks with rollback), Discard, Keep, test discovery (package.json, justfile, Makefile), check outcome logged as test_result; stall/crash/failed-test/conflict states on map + card. QA ran live (10/10 contracts, 8/8 browser, 3 fixes with regressions); report /tmp/qa-step5/qa-report-step5.md.
- Ribbon bridges (PR #20) and step 5 (PR #21) are independent branches off main; rebase the second after the first merges.
- Still owed: cross-model review (Opus/Codex limited 2026-10-28, retry); live Claude pause/resume; adapter TestResult for agent-run tests.

## Updates (2026-10-29, review rounds)

- PR #21 at 15f0944. Four review rounds, all fixed with regression tests: Opus (3 P0 + 5 P1: session locks, check drain, hook abort, discard order), Codex (P1 auto-start lock + 2 P2: orphan reap, prune/branch errors), Opus re-review (6 P2: accept-stands-on-cleanup-failure, final reap, narrow prune, closed-quest silence), Codex closing (6 P2: full cleanup hint, LC_ALL=C prune, card warning, root guards, detached-only orphan test). Last two rounds found no P0/P1; reviews converged, no further round scheduled.
- Gates on the final tree: cargo 42 lib + 13 finish_flow + suites, clippy clean, Vitest 94, tsc clean, Playwright 6/6. Live re-probe through the real binary 3/3 (Accept, Discard prune, double-Accept race); agent run scaffolded via sqlite worktree_path (spawn path untouched, proven live in QA). Script: /tmp/reprobe-step5.sh (lives outside /tmp/repro-step5, which it wipes).
- Known limits: killpg id can theoretically recycle under extreme churn (documented in code); orphan pid test assumes PID 1 reaps (macOS launchd; no Linux CI); 5-min check timeout path code-reviewed, never executed live; muse runs use --approval-mode never (T8 must tighten).
- Step 5 needs the owner now: taste-check the finish UI + merge PR #21 (after PR #20 merges, rebase). Then step 6 drag-connect.

## Updates (2026-10-29, step 6 drag-connect — lanes + born bridges)

- PR #20 (ribbons) and PR #21 (step 5) merged to main (a3baa05); step-5 branch rebased before merge. Owner is taste-checking finish UI on :8788 (taste) + :5173.
- Step 6 on `feat/step6-drag-connect`: server `source_island_id` (nullable, migrates old DBs; refuses same-island + island-less source at create); pure `lane.ts` (task text, drop validation, cycle path, dashes, reconcile fns); lane layer + island drag input + editable confirm flow (Escape/Close/water cancels; create re-validates, needs an agent, stores source).
- Reconcile: `pendingLanes` (open drag quests without the import draw; terminal/satisfied drop out); `bornBridges` (accepted drag quests whose REAL import exists draw a deck + glow despite weak counts — an accepted quest without the import draws nothing). renderCity: pair keys, born set with change-gated rebuild (drawBridges frees GPU buffers), glow build extracted for rebuild. Glows pulse at island zoom only (existing D-zoom rule).
- Verified live (GestiKo, taste server): lane draws for open drag quest; lane drops (1→0) when a real staged import lands (reverted after); accepted + import → born deck +1 sprite/+1 glow, planks + posts + pulse visible at island zoom (/tmp/born-island.png). Accepted state staged via sqlite (accept route needs a worktree run; guards covered by finish_flow tests). Probes archived after via API; GestiKo clean.
- Left: e2e drag journey, full gates, /qa (cancel/edit/confirm/cycle), push + PR. Tests now: Vitest 137, tsc clean, Playwright 6/6.

## Open questions carried in the design doc

- Exact Meta AI tooling requirement (gate 1 answers this).
- Command bar, quest log and report card visuals. Mocked; variant A "Harbor bar" approved by the owner on 2026-10-27. Build is T12.
- Whether Louvain refinement passes the naming test (day-1 spike).
- Demo-repo test-command source if none of `package.json`/justfile/Makefile exists (shows as "not run" per D15).
