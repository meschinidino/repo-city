# CLI fixtures — SIMULATED

The JSONL files here are **hand-written simulations** of CLI output,
recorded in the shape the installed CLIs emit. They prove translation
logic only (design R17/L2). They are never evidence of live-agent
behavior; live numbers come from the T3 spike report against the real
CLI.

Exception: `muse-exec-real.jsonl` is not hand-written. It is lines
recorded from one real `muse exec --json` run (2026-10-28, a file
create in a throwaway repo), kept so the Muse translator is tested
against the true envelope. It still proves translation only.
