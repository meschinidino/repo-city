# Meta AI tooling rule check (T1)

Status: done 2026-10-26. This file is the write-up owed by T1 in
[specs/design.md](../specs/design.md) and [ROADMAP.md](../ROADMAP.md) step 2.

## What was checked

- The Meta Global AI Developer Hackathon Official Rules were accepted in the
  Cerebral Valley portal.
- Discord #office-hours was asked what counts for the "Use of Meta AI tooling"
  criterion (25% of the score) and whether the code-editing agent must run on a
  Meta model.
- The office-hours answer has not landed yet. Until it does, the approved
  runtime fallback split in specs/design.md (Committed Contracts) governs:
  a stronger coding model or an existing coding-agent CLI edits code; Llama
  runs naming, narration, and reports. If the answer requires a Meta-model
  agent, the same split says the live loop, event mapping, and reports stay
  identical and demo tasks are chosen small enough for that model.

## Llama must be visibly load-bearing in the demo

- English report from the real diff when a session ends.
- Drag-connect task text in the confirmation card.
- Plain-English bridge (edge) labels, marked as explanations, not facts.
- Island naming on repo open (cached in SQLite per file-content hash).

If Llama is unavailable, slow, or weak, the approved fallback applies:
deterministic island names from folder/package names, and template reports
built from the real diff. The city and sessions keep working with no model
calls.

## Llama access path (decision, 2026-10-26, Dino)

- Provider: Meta's API, using the API credits granted for this hackathon.
  (Event-page partner credits also exist — Baseten $100, Modal $100,
  Fireworks $25 for select participants — and stay as backups.)
- The API key lives in the user's environment or OS keychain only, following
  the safety model in specs/design.md. Working convention: the server reads
  it from the `LLAMA_API_KEY` environment variable. The key is never written
  into this repo, the session store, event logs, or reports, and is redacted
  from stored events (T8).

## Will the credits be enough?

Expected enough for the demo workload, and measurable before it matters:

- The calls are small text jobs: one naming call per district per content
  change (then cached), one label per bridge, one task text per drag, one
  report per finished session. A demo repo with tens of districts and a
  handful of sessions is hundreds of short calls, not thousands.
- The real consumers to watch are the eval harness runs on pinned fixtures
  (step 3) and demo rehearsals (step 8). Both are bounded and can be pointed
  at the fallback template while iterating.
- Verify before the day-3 gate: log token counts per call type in the server
  for one week of normal use, and confirm the granted credit amount and the
  available model names in the Meta API console. If the projection exceeds
  the credits, switch the eval/rehearsal traffic to a partner provider and
  keep the demo path on Meta.

## Still open

- The Discord #office-hours answer (does building with an existing coding
  CLI count, and which models qualify). When it lands, update this file and
  the T1 lines in specs/design.md and ROADMAP.md; if it contradicts the
  fallback split, the runtime decision is re-asked before adapter code
  depends on it.
- Confirm in the Meta API console: exact credit amount, expiry, and which
  Llama models the key can call.
