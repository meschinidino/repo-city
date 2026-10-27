---
# gstack: design-md-format=spec
name: Repo City
description: A low-poly quest archipelago, calm sea, readable islands, and small bright signs of agents at work.
colors:
  primary: "#E8812B"        # sail orange: agents, their ships and their controls
  on-primary: "#1F1206"
  surface: "#13262B"        # deep-sea ink: the command bar and cards that float over the map
  surface-raised: "#1C353B"
  text: "#EAF2F0"
  text-muted: "#9DB5B8"
  accent: "#FFE3A3"         # lane gold: a route being built, the selection ring
  success: "#3E9A5B"        # green pennant, tests passed
  warning: "#E0A33A"        # stalled, "no news"
  error: "#D4402B"          # red pennant, failed, crashed
  sea: "#4F98A6"
  sea-deep: "#3A8496"
  sea-shallow: "#8FD8CF"
  sand: "#E8CF92"
  grass: "#9CC54A"
  rock: "#6E6458"
  wood: "#B98652"
  wood-dark: "#7A5432"
  window-lit: "#F6C85F"
typography:
  display:
    fontFamily: Bricolage Grotesque
    fontWeight: 800
    fontSize: clamp(1.25rem, 2.2vw, 2rem)
    letterSpacing: -0.01em
  body:
    fontFamily: Overpass
    fontWeight: 400
    fontSize: 1rem
    lineHeight: 1.5
  label:
    fontFamily: Overpass
    fontWeight: 800
    fontSize: 0.75rem
    letterSpacing: 0.06em
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
    fontFeature: tnum
rounded:
  sm: 4px
  md: 6px
  lg: 10px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-primary-hover:
    backgroundColor: "#F2934A"
  command-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
  agent-token:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.full}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
  input:
    borderColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
  island-label:
    textColor: "#FFFFFF"
---

# Repo City

## Overview

**Version:** 0.1.0 (see [CHANGELOG.md](CHANGELOG.md); step 1 of [ROADMAP.md](ROADMAP.md)).

**Creative North Star:** a repo you can read in one glance, with agents you can see working inside it. Modules are islands in a calm sea; the sea does the separating that a dense city never could.

**Product context:** an app that manages AI coding-agent sessions for one TypeScript/JavaScript repo. A local Rust binary serves a PixiJS 2D isometric client. Judges see it through a 3-minute video, so it must read as a game you operate, never as a dashboard.

**Mode per surface:**
- The map: Experience and Operate. It is the whole screen.
- Command bar and quest log: Operate.
- Reports and cards: Read.
- Code drill-down: Read, in mono.

**Reference sites:** Dorfromantik, Monument Valley 2 (islands as places), Mini Motorways and Mini Metro (readability, highlighted route), Timberborn and Anno (function legible from shape), Tiny Glade (a lit window as presence), Into the Breach (outcomes painted on the map). Moodboard votes: https://claude.ai/artifact/CFEghD36uSQxc51eoadZrE. Concept comparison: https://claude.ai/artifact/MFR5D645P8mLhdiiXXzYNQ. Sprite spike with live checks: https://claude.ai/artifact/LBVcGZJPPyKJfaCbiHBxWB.

**Key characteristics:**
- Few clear islands with open water between them; you can name every module from across the room.
- Every building's shape says what its file does. A file with endpoints never looks like a file that does nothing.
- The world is still. Light, ships, scaffolding and pennants move or change only when an agent does something real.
- Stylized low-poly, warm soft light from the upper left, matte materials. Not dense realism, not pixel art, not neon.

## The world

| In the repo | On the map |
|---|---|
| Module (top-level directory or workspace package) | An island |
| Import edge between modules | A bridge (built, solid) |
| A route being built (drag-connect, before the import exists) | A glowing dashed lane on the water |
| Agent session | A ship with an orange sail and a token in the command bar |
| Agent touching a file | That building's windows light up; scaffolding while it is being edited |
| Test result | A green or red pennant over the buildings the test covers |
| New module | An island rising from the sea once the folder actually exists |
| You | The home harbor at the map edge, where idle ships dock |

**Building types** (by what the file does, detected from the extraction parse; Llama classifies what the rules can't):

| File | Building | Footprint |
|---|---|---|
| Entry point (package entry, server bootstrap) | Keep, the island's landmark | 2×2 |
| Exposes endpoints | Sea gate on the shore, facing open water | 1×1, on a front-facing shore cell |
| Reads or writes data | Silos and warehouse | 2×2 |
| Shared utility with many importers | Lighthouse | 1×1 |
| UI components | Market stalls | 2×1 (3×1 if the sprite measures that way) |
| Generated or vendored | Containers and crane | 1×1 |
| Dead code (no importers) | Ruin: collapsed, ivy, never lit, no path to it | 1×1 |
| Ordinary file | Cottage; merged into a village at city zoom | 1×1 |
| Being edited by an agent | Construction: scaffolding over the building | the building's own |

Tests, config and type-only files are not buildings. Tests show as pennants; config and types fold into the cottages.

**Zoom levels.** At map zoom an island shows only its landmarks and a housing mass sized by file count. At island zoom files with a job get their own building. At file zoom names appear on hover and the code opens underneath.

## Colors

**Strategy:** committed. The sea owns the screen; islands carry natural greens and sand; the one strong hue is sail orange, reserved for agents. Lane gold marks a route being built and the current selection. Semantic colors appear only as pennants and status, never as island tints.

**Light or dark:** neither, by design. The world has its own daylight palette in every theme, because the map is a lit scene, not a document. UI that floats over it (command bar, cards) uses the deep-sea ink surface with light text in both themes, so it reads against water and grass alike.

Island identity comes from landmarks, roofs, banners and labels, never from tinted ground: a blue-tinted grass tile read as sea in testing. Night is not a theme; lit windows are a signal.

## Typography

- **Bricolage Grotesque 800** for island names and the few large headings. Labels sit on the water beside the island, horizontal, white with a soft dark outline.
- **Overpass** for everything you operate and read: the command bar, quest log, report cards. 800 in uppercase with tracking for small labels (`3 FILES · 2 AGENTS`).
- **JetBrains Mono** for paths, branches and code drill-down only.
- All three load from Google Fonts (`css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Overpass:wght@400;600;800&family=JetBrains+Mono:wght@400;600`), verified 2026-10-26.

## Layout

- The map is full-bleed. There is no top bar, no sidebar and no chat box.
- **Command bar:** one slim bar along the bottom edge. One token per agent: portrait, name, model tag (Claude or Muse), one-line quest, status. Clicking it opens the quest log above the bar, where sessions are created, paused, resumed, stopped, archived, and sent follow-ups. This is the command center; it is a game's quest log, not an admin table.
- **Quests:** a quest is a session's task in plain English ("Add friend groups"). Creating one names the target island and the agent model.
- **Report card:** opens next to the island it belongs to, with a fine leader line to the island. It holds the English report and Accept / Discard / Keep for later.
- **Radial menu** around a clicked island or building for editing actions (from Mini Motorways), never a panel.
- Hackathon scope: one map, up to about 2,000 files, at most 3 agents.
- Status: the command bar, quest log and report card are specified here. Three mock variants were made on 2026-10-27; the owner approved variant A, "Harbor bar" (record: `specs/step4-plan.md`). Not built yet; T12 builds it.

## Elevation & Depth

- The map's depth comes from the sprites' baked light and the tile thickness (one shared side height for every tile).
- Shallow water is a soft halo around each island, drawn in code under the tiles.
- Floating UI uses an offset, soft shadow (`0 6px 20px rgba(8,24,28,.35)`), never a zero-offset glow.
- The only glow in the product is the lane being built, and it means exactly that.

## Shapes

- UI: 4px for inputs, 6px for buttons, 10px for the command bar and cards, full round for agent tokens. Inner radius = outer radius minus the gap.
- World: the isometric 2:1 grid is the shape language. Everything on the map is placed on it.

## Components

- **Agent token:** default, hover (lifts 2px, shows the full quest), focus-visible (lane-gold ring), working (a small orange pulse at the edge, only while events arrive), stalled ("no news · 4m" in warning), failed (error ring and "crashed"). Never a fake progress bar.
- **Quest log:** list of sessions with state, island and model; the create form at the top (quest text, island, model). Empty state: "No quests yet. Drag a lane between two islands, or write a quest."
- **Report card:** title is the outcome in one sentence ("Checkout now validates payment requests"). Body: what changed, files, tests run and their results, what was not verified. Footer: Accept, Discard, Keep for later. Raw events and diff stats replace it if the report can't be generated, labeled "report unavailable".
- **Drag-connect:** dragging from one island to another draws a dashed lane; releasing opens the editable quest confirmation. The lane stays dashed until a real import exists, then it becomes a bridge.
- **Island label:** Bricolage 800, white, soft dark outline, on the water.

## Sprite pipeline

All world art except the sea, lanes, bridges and labels is generated, then placed by measurement. These rules came out of four spike rounds and are enforced by checks.

**In the repo:**
- `assets/sprites/buildings.png`, `market-flags-trees.png`, `coast.png`, `ship.png`: the sheets in use.
- `assets/briefs/`: the exact Codex briefs that produced them (and the concept art), to regenerate or extend a sheet.
- `docs/design/concepts/`: the approved overview and close-up concepts.
- `prototype/sprite-spike/index.html`: the reference implementation of every rule below, with the checks. Serve the repo root (`python3 -m http.server 8000`) and open `/prototype/sprite-spike/`.

**Generation (Codex image generation through the OpenAI subscription):**
- One sheet per request, a 4×3 grid of objects, landscape 3:2, on flat pure magenta `#FF00FF`.
- Every building, tree and prop stands on a flat pure cyan `#00FFFF` footprint plate of an exact size (1×1, 2×1, 2×2, 3×1). The whole base sits inside the plate with a strip of cyan around it.
- No bases, no water squares, no people, no animals, no text. Camera isometric from the south-east, light from the upper left.
- Attach an earlier approved sheet as a reference for style and scale on every new request (`codex exec -i assets/sprites/buildings.png ... - < assets/briefs/<sheet>.txt`; the image lands in `~/.codex/generated_images/<thread>/`).
- Generate two runs and keep the one with better measurements.

**Assembly (in the client, at load):**
- Key out magenta; cut sprites out as connected shapes, assigned by sheet cell. Nothing is cut at a fixed line.
- Plates: measure left, right and front corners; scale from the plate (the smaller axis scale, so a long plate still fits); grow so the building's own base fills 92% of the footprint; then key the plate out.
- Footprint: the candidate closest to the measured plate shape (a long market becomes 3×1, not a squeezed 2×1).
- Tiles: fit the two upper edges of the silhouette, derive the corners, warp onto the exact grid diamond and clip to one shared tile shape. Tiles cannot overlap.
- Coast: each shore cell picks its tile from which neighbors are water.
- Layout: an occupancy grid. Buildings on land only, one free cell around each, landmarks near the island center, the sea gate on a front-facing shore, bridge landings reserved. Trees on any other free cell except directly in front of a building.
- Bridges, lanes, sea and labels are drawn in code from grid coordinates.
- Landmark size comes from the footprint, not from scaling a sprite up.

**Checks (computed at load in the spike today; the client build should fail when a fail-level check fails):**

| Check | Pass |
|---|---|
| Sprites found / cropped at the sheet edge | all found, 0 cropped |
| Plate shape vs footprint | under 8% off |
| Base outside its footprint | under 3% |
| Tile edge error after fitting | under 1% of tile width (currently 1.39%: watch) |
| Gaps inside a tile's top face | under 0.5% |
| Footprints overlapping, off land, on a bridge landing | 0 |
| Buildings without one free cell around them | 0 |
| Trees on a footprint or road, or in front of a building | 0 |
| Share of a building hidden by others | under 10% |
| Shore cells without an exact coast tile | 0 |

Inspect at full size (200 px per tile) before calling a scene done.

## Do's and Don'ts

- Do give every file type a distinct silhouette, and keep the type table above as the source of truth.
- Do move or light something only on a real event: a ship sails on session start, windows light on file touch, scaffolding on edit, pennants on test results.
- Do keep district identity in landmarks and banners, and the ground natural.
- Do measure, then place. Every sprite enters the map through its plate.
- Do check the scene at full size before showing it.
- Don't animate agents commuting along bridges or lanes. Imports are dependencies, not paths an agent took.
- Don't add a top bar, sidebar, chat box or settings panel over the map.
- Don't use dense realism (Anno, Skylines, Frostpunk): votes showed it reads as beautiful and unreadable.
- Don't put people, hard-hat workers or smoke on the map.
- Don't use neon, glowing edges or night as a look.

## Motion

- **Approach:** intentional, and event-driven. The world is still unless an agent acts.
- **Easing:** enter ease-out, exit ease-in, move ease-in-out.
- **Duration:** micro 80ms (hover), short 200ms (token and card), medium 350ms (camera, ship departure), long 600ms (island rising).
- **The one authored moment:** a new module's island rising from the sea with a ring of foam, when its folder appears.
- Respect `prefers-reduced-motion`: replace movement with a fade and keep state changes.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-26 | Round 1 mockups rejected (Factorio Dusk, Clean SimCity, Night Grid) | Same dashboard layout with a painted city inside; only the palette changed |
| 2026-10-26 | Round 2 directions (Maquette, Working Atlas, Transit model) judged not ambitious | Buildings carried no meaning; one square per file doesn't scale; code-drawn boxes look plain |
| 2026-10-26 | Quest archipelago | Moodboard v2 votes: keeps on separate islands, Dorfromantik board, function-legible buildings; Dino's note asking for a command center and quests |
| 2026-10-26 | Codex image generation for art | Concept board: "Muse was smarter but had worse taste. Codex has incredible taste." |
| 2026-10-26 | Stylized low-poly, not pixel art | Switched by Dino at the sprite spike |
| 2026-10-26 | Sprites placed by measured plates, tiles fitted to the grid, occupancy layout | Dino's rules after round 2: base inside its tiles, no overlaps, tiles aligned as a grid |
| 2026-10-26 | Initial design system created (v0.1.0) | Created by /design-consultation from the moodboard votes, concept board and four sprite spike rounds |
