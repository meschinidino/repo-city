# Requirements — Harbor bar

Functional:
- The bar is always visible at the bottom of the city view: New
  quest button, one token per session of the open repo, status line.
- A token shows: ship mark, agent, island name (or "no island"),
  state in plain words, status dot (working pulses only while the
  session is working).
- New quest opens the quest log with a create form: quest text in
  plain English, target island from a list or by clicking the map
  (lane-gold ring on the picked island, name in the form), agent
  choice (Claude agent / watch only, no agent spawned).
- At 3 active quests (working or paused), create is disabled and
  the form names the running quests (D-cap).
- Selecting a token shows that session in the quest log with the
  actions its state allows: pause (working), resume (paused),
  stop, archive (finished/stopped/failed), follow-up text.
- A failed action shows the server's refusal in the quest log;
  nothing is shown as done that the server did not do.
- When a session finishes, its report opens in the report card
  beside its island (leader line, viewport-clamped), with the
  line "Finish flow arrives in step 5". Without an island, the
  card docks to the right edge.
- With no repo open, the bar is the repo opener: path input and
  Open, using the QA refusal copy for bad paths (D-open).

Non-functional:
- CSS variables from DESIGN.md tokens (colors, radii) for every
  floating surface; no new raw palette.
- Under 720px: compact tokens (mark, island, state), quest log as
  a full-width sheet, 44px touch targets (D-mobile).
- Keyboard: island list is the create form's target control;
  focus rings in lane gold.
- The day-3 journey keeps working: status text, Stop & report,
  auto-created primary session, report in #report.
