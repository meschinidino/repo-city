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
