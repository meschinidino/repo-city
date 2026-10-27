# Paper test — GestiKo (3-minute story)

Status: **prepared, not yet run.** It needs the GestiKo repo owner in
person (or on a call) for about five minutes. Record the outcome at
the bottom of this file when it happens; until then no retelling
result exists and none should be claimed.

## The check

From `notes/working-notes.md`: open the repo, the owner names three
districts, narrates one agent task and its English report, then
retells what the repo does in 20 seconds. If they cannot, the
district model is wrong, not the art.

## Setup (two commands, then one URL)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo run --manifest-path server/Cargo.toml --bin repo-city-server-bin -- --port 8787
npm --prefix client run dev
```

Open (adjust the repo path to the local GestiKo clone):

```
http://localhost:5173/?repo=/tmp/GestiKo&server=http://127.0.0.1:8787
```

## Script for whoever runs it

1. "What are the big pieces of this repo?" — the owner should be able
   to point at islands and name at least three districts unaided.
2. Start a session (add `&spawn=1&task=...` to the URL with a small,
   safe task), watch the ship sail and windows light, stop it, read
   the report card together.
3. "Tell me in 20 seconds what this repo does." Time it. Write down
   their words verbatim.

## District answer key (from the live extraction, 600 files)

Measured 2026-10-27 against the `/tmp/GestiKo` clone: 43 islands,
234 bridges. Largest districts a viewer should find:

| Island | Files | What the name says it holds |
|---|---|---|
| `backend` (root) | 215 | the Python backend outside its modules |
| `frontend` (root) | 103 | the TS frontend outside its features |
| `backend/app/modules/sales` | 24 | sales |
| `backend/app/modules/price_lists` | 22 | price lists |
| `frontend/src/features/sales` | 21 | sales UI |
| `backend/app/modules/purchases` | 20 | purchases |
| `backend/app/modules/commercial` | 14 | commercial |
| `frontend/src/features/commercial` | 11 | commercial UI |

Purposes in the right column are read off directory names only —
that is exactly what the test checks a fresh viewer can do.

## Outcome record

- Date / who ran it / owner present: _not run yet_
- Three districts the owner named unaided: _pending_
- 20-second retelling (verbatim): _pending_
- Verdict (retold it / could not): _pending_
