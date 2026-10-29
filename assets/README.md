# Assets

Generated art for the map and the briefs that made it. The rules for making and placing these are in [DESIGN.md](../DESIGN.md) under "Sprite pipeline"; the reference implementation is [prototype/sprite-spike/](../prototype/sprite-spike/).

| Sheet | Contents (4×3 grid, reading order) | Brief | References attached when generated |
|---|---|---|---|
| `sprites/buildings.png` | Keep (2×2), sea gate, silos (2×2), lighthouse, cottage, slate cottage, market (superseded), containers, ruin, flags (superseded), construction; last cell empty | `briefs/buildings.txt` | the round-2 buildings sheet and the round-1 terrain sheet (archived in `~/.gstack/projects/meta-hackathon/designs/sprites-20261026/`) |
| `sprites/market-flags-trees.png` | Market 2×1, market 3×1, flags, pine, broad-leaf tree, three pines, bushes, birch, cypress, autumn tree, flowering bush, boulder with sapling | `briefs/market-flags-trees.txt` | `sprites/buildings.png` |
| `sprites/coast.png` | Grass tiles with a beach strip on: each single edge (4), each outer corner (4), all edges, none (plain grass, used for island interiors), two three-edge variants | `briefs/coast.txt` | the round-1 buildings and terrain sheets (archived) |
| `sprites/ship.png` | The agent's ship, cropped from the round-2 buildings sheet (cell 10) | `briefs/ship-source.txt` (the full round-2 sheet brief) | the round-1 sheets (archived) |

`briefs/concept-overview.txt` and `briefs/concept-closeup.txt` produced the approved concept art in [docs/design/concepts/](../docs/design/concepts/).

Bridge tiles (not sheets): `bridge-a.png` / `bridge-b.png` are the two straight-deck directions (levelled post-to-post units, cropped at 88% height), `bridge-corner.png` is the sharp-joint miter (E opening; the renderer mirrors it for W) composited from the straight tiles at ±atan(0.5) — see the CHANGELOG for the 8 failed generations behind it. `glow-0..2.png` are the direction-pulse frames. Corner briefs: `briefs/bridge-corner.txt` (v1), `briefs/bridge-corner-b.txt` (v2).

All sheets were made with Codex image generation (`codex exec -i <reference.png> ... - < brief.txt`) on 2026-10-26. Every sheet is on flat magenta `#FF00FF`; buildings, trees and props stand on flat cyan `#00FFFF` footprint plates. Both colors are keyed out at load.
