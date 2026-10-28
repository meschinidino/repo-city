# Validation — Harbor bar

Technical checks:
- `npm --prefix client test` (Vitest incl. new bar helper tests).
- `cd client && ./node_modules/.bin/tsc --noEmit`.
- `npm --prefix client run test:e2e` (existing 3 + new harbor
  journey: create a quest from the form, token appears, pause,
  resume, archive; against a fixture repo and a test server).

Manual checks (browser, GestiKo):
- Bar reads as the approved variant A: tokens along the bottom,
  quest log above the bar, map first.
- Click an island: lane-gold ring, name in the form.
- Create three quests: the fourth is refused in words, naming
  the three.
- Finish one: report card beside its island with leader line.
- Narrow window (<720px): compact tokens, sheet quest log.

Closure: checks green, PR open for owner judgement (UI taste is
not auto-merged). Simulated vs real: sessions in e2e are
watcher-only (spawn=false); no live Claude run is claimed.

## Results (2026-10-28)

- Vitest 78 pass (bar helpers incl. the server cap rule),
  tsc clean, Playwright 4 pass (day-3 journey unchanged, harbor
  journey: tokens, create, watch-only cap exemption, pause,
  resume, stop, archive).
- Manual: variant A layout on GestiKo at full size and at
  390x780 (screenshots taken in-session). The local dev DB holds
  ~98 stale working sessions; tokens now scroll in one row and
  the cap note names three plus the rest.
- Cross reviews: Codex (3 findings) and Claude Opus (7 findings)
  all fixed except two noted items: repo-path spelling variants
  hide sessions (server stores the raw string), and an elbow leg
  can hug its own shore (unconfirmed, from the bridge work).
- Simulated vs real: e2e sessions are watcher-only. No live
  Claude process pause/resume is claimed here.

## Owner feedback + QA round (2026-10-28, later)

- Owner points 1-5 addressed in code: bar restyle (gradient,
  orange top border, gradient tokens, ship icon), model/effort
  pickers end to end (server check, storage, spawn/resume/
  follow-up args), pulsing island ring, stable token order,
  report card above the island with measured heights.
- QA (gstack-qa): responsive probe at 390/360/320px. One defect
  found and fixed: the quest log sheet overlapped the bar buttons
  at narrow widths (fixed bar offset vs wrapping bar). The sheet
  now measures the bar (ResizeObserver). Regression kept as
  `client/e2e/responsive.spec.ts`.
- Cross review: Claude Opus read-only pass over the round diff;
  8 fixes made, 2 claims checked and closed (CLI accepts
  `--model`/`--effort`; all session queries read the new
  columns). New unit tests: model/effort validation (3 tests).
- Gates after the round: Vitest 78, tsc clean, Playwright 5,
  cargo tests pass (24 lib), clippy clean.
- Honest limits: e2e sessions are watcher-only (spawn=false).
  No live Claude run with a chosen model/effort has been
  observed. The owner has not judged this round yet; PR #18
  stays open.

## Muse option added (2026-10-28, later still)

- Owner: "still no muse option." The Agent list now offers
  Muse, with per-agent model/effort lists and server checks.
- Real runs through the API (not fixtures): create with
  model muse-spark-1.3 finished and wrote hello.txt in the
  worktree; follow-up wrote second.txt in the same session;
  a slow quest paused mid-run, resumed on the same Muse
  session id, and finished with its file written.
- Cross review: Claude Opus, two passes; 10+ fixes (see
  CHANGELOG). Open gap, shared with Claude: pause/stop kill
  the agent process, not its process group.
- Gates: Vitest 80, tsc clean, Playwright 5, cargo tests
  pass, clippy clean. PR #18 stays open for owner judgement.

## Ship dock, feed, talk-to-agent (2026-10-28, later still)

- Owner round: Wonder Full model, ship dock on quest start,
  agent reasoning and replies visible, a way to talk to the
  agent. All five built.
- Live proof: queued message auto-ran after the first run
  finished (real Muse, API-driven) and wrote its file.
  Wonder Full: catalog id real, this account lacks access —
  the CLI refusal shows as the failure reason.
- Reasoning honesty: Muse streams carry no reasoning text
  (token count only); this account's Claude runs emitted no
  thinking blocks either. The mapping is unit-tested against
  the documented block shape; no live reasoning line seen yet.
- Cross review by Codex (Opus at its limit; it still owes
  this diff a pass): 4 P1 races fixed, listed in CHANGELOG.
- Gates: Vitest 83, tsc clean, Playwright 5, cargo pass,
  clippy clean. PR #18 stays open for owner judgement.
