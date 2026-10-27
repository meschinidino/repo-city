# Repo City client (T11)

PixiJS + TypeScript client holding the sprite pipeline ported from
`prototype/sprite-spike/index.html`. Sheets load from `assets/sprites/`
(bundled by Vite); nothing under `assets/` is copied or modified.

## Run

```bash
npm --prefix client install
npm --prefix client run dev   # http://localhost:5173/  (?full=1 renders at 200 px per tile)
npm --prefix client test      # Vitest geometry checks against the committed sheets
npm --prefix client run build # tsc --noEmit + vite build
npm --prefix client run test:e2e:install # one-time: Playwright Chromium
npm --prefix client run test:e2e         # Playwright smoke (starts the dev server itself)
```

E2E scope today is one smoke spec (`e2e/smoke.spec.ts`): the client loads, the
fail-level checks pass in the page, the three islands render with real map
pixels, and the full-size canvas is 4200×2440. The five user journeys in
`specs/test-plan.md` get specs when the features they drive (sessions, event
stream, finish flow) exist.

## Layout

- `src/map/colorKey.ts` — magenta keying, cyan plate keying/despill.
- `src/map/components.ts` — cut-out by connected shape, ordered by 4×3 sheet cell.
- `src/map/plate.ts` — plate corner measurement, overhang/reach, footprint choice.
- `src/map/tileFit.ts` — tile corner fit, affine warp, edge straightening, shared-shape clip.
- `src/map/coast.ts` — coast autotiling by water-neighbour mask.
- `src/map/layout.ts` — occupancy layout with spacing, bridge landings, trees.
- `src/map/drawGeometry.ts` — code-drawn bridge/lane geometry.
- `src/map/pipeline.ts` — pure pipeline over decoded pixels (browser and tests share it).
- `src/map/renderPixi.ts` — Pixi scene: sea, tiles, bridges, buildings, ships, lane, labels.
- `src/map/pipeline.test.ts` — every check from the prototype's checks table, at the
  pass levels in `DESIGN.md`. Fail-level checks also gate the render in `src/main.ts`.

## Measured on the committed sheets (2026-10-26)

- Tile edge error: prototype metric reproduces at **1.394%** worst. After the
  edge-straightening step in `fitTile` (per-column shift by the smoothed residual
  to the ideal diamond), the fitted tiles measure **0.25%** worst — under the 1%
  target in `DESIGN.md`. Both numbers are printed by the test.
- All other fail-level checks pass; see the test output for the full table.

## Full-size comparison

Rendered at 200 px per tile (4200×2440 canvas) and compared pixel-by-pixel with
the prototype at the same size in a headless Chromium: mean absolute channel
difference 1.32, 0.7% of pixels differ by more than 60/765. Remaining differences
are the straighter tile edges (the improvement above), texture filtering, and
the label font (system font here; the prototype loads Bricolage Grotesque).
