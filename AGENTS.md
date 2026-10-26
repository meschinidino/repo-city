# AGENTS.md

Project rules for any coding agent working in this repo (Muse Code reads this file; Claude Code reads `CLAUDE.md`, which points here). Work in English.

## What this is

Repo City manages AI coding-agent sessions for one TypeScript/JavaScript repo, rendered as a low-poly isometric archipelago: modules are islands, imports are bridges, sessions are ships, and a bottom command bar with a quest log is the only panel. One Rust binary (Axum) serves a PixiJS client. Built for the Meta Global AI Developer Hackathon; submission is due **Nov 4, 2026, 9:00 PM ET**. It must read as a game you operate, never as a dashboard.

## Read first, in this order

1. [notes/working-notes.md](notes/working-notes.md): where the plan lives, binding decisions, gates, honesty rules.
2. [ROADMAP.md](ROADMAP.md): steps in order; step 1 is done. Lines marked **▸ gstack** name the gstack skill to run at that point (for example `/review` before every merge, `/qa` at each journey, `/plan-design-review` before the command bar). Run them when you reach that point, and say in your report which ones you ran.
3. [specs/design.md](specs/design.md): the approved design, committed contracts, decision ledger D1–D23, tasks T1–T12. Its decisions are binding; don't re-open them without the user.
4. [DESIGN.md](DESIGN.md) before any visual or UI work: world model, building types, tokens, layout, motion, and the sprite pipeline rules and checks.
5. [specs/test-plan.md](specs/test-plan.md) before writing tests.

## Where to start

Roadmap step 2. Gate order matters:

1. **T1 — Meta AI tooling rule check comes before any adapter code.** It needs the user (accepting the Official Rules in the portal, Discord #office-hours for ambiguity). Don't write adapter code (T3) or the permission bridge (T8) until T1's answer is recorded in `docs/meta-tooling-rule.md`.
2. **Can start without T1:**
   - T2: Oxc extraction spike (directory-first islands, import bridges, parsed/resolved/unresolved counts). Use the user's friend's repo once it exists; until then a TS/JS fixture repo, labeled as a stand-in.
   - T11: port `prototype/sprite-spike/` into a client module, with its geometry checks as Vitest tests against `assets/sprites/`.
3. **Day-3 kill gate:** one repo, one session, directory islands, motion only on real file events, English report lands. If it fails, cut visual fidelity, never the control loop or drag-connect.

Never cut: real event mapping, the finish flow, failure states, English reports, drag-connect.

## Honesty rules (non-negotiable)

- Never say "verified", "tested against the real backend" or "works end to end" if any part was simulated (mocks, intercepted requests, hand-built responses, stubs, fixtures).
- If something from the backend or environment is missing (an endpoint that doesn't exist, a stale image, a service down, a missing key), **stop and report it as a blocker**: say what is missing and what the user has to do.
- Simulating to make progress is allowed, but say so at the top of the report: what was simulated, why, and what is needed to test it for real.
- Always separate "tested with simulation" from "tested end to end".
- In the product: workers and ships move only on real events, unknown locations are shown as unknown, and every report is generated from the real diff. Recorded CLI fixtures are labeled simulated in test names and prove translation only.
- For visual work, check the result at full size (200 px per tile) and report measured numbers, not adjectives.

## Design rules

- `DESIGN.md` is the source of truth for anything visual. Ask the user before departing from it; flag UI code that doesn't match it.
- New art follows the sprite pipeline in `DESIGN.md`: 4×3 sheets on magenta `#FF00FF`, cyan `#00FFFF` footprint plates, no people, attach an approved sheet as reference, generate two runs and keep the better-measured one. The briefs that made the current sheets are in `assets/briefs/`.
- Sprites are placed by measurement and rules (plates, grid-fitted tiles, occupancy grid). Never by eye.

## Docs and sync

- The canonical planning docs live in `~/.gstack/projects/meta-hackathon/` (design doc, test plan, tasks). When you change one, change the canonical copy first and re-copy it into `specs/` in the same commit. If that folder isn't available to you, edit the repo copy and say so in the PR so the canonical copy gets updated.
- Record user-visible changes in `CHANGELOG.md` and bump `VERSION` for each release.

## Commands

- Sprite pipeline prototype: `python3 -m http.server 8000` from the repo root, then open `http://localhost:8000/prototype/sprite-spike/`. The checks table at the top recomputes on every load.
- No build or test commands exist yet; T10 adds a one-command run.

## Git

- Never commit or push to `main` directly. Work on a branch, open a PR, and only when the user asks.
- No force pushes, no history rewrites, no `reset --hard` on shared branches.
- Owner and reviewer: Dino (`meschinidino`).
