import type { Placed } from "./layout";
import type { BuiltSprite } from "./pipeline";
import { projector } from "./world";

export interface Placement { x: number; y: number; scale: number; width: number; height: number; depth: number }

/** Plate centre to footprint centre, smaller axis scale, grow to 92% (trees don't grow). Shared by Pixi and occlusion. */
export function spritePlacement(pl: Placed, sprite: BuiltSprite, TW: number): Placement {
  const { project, TH } = projector(TW);
  const pt = sprite.plate!;
  const unit = Math.hypot(TW / 2, TH / 2);
  const grow = pl.tree ? 1 : Math.min(1.5, 0.92 / pt.reach);
  const scale = Math.min(
    (pl.w * unit) / Math.hypot(pt.B[0] - pt.L[0], pt.B[1] - pt.L[1]),
    (pl.d * unit) / Math.hypot(pt.R[0] - pt.B[0], pt.R[1] - pt.B[1]),
  ) * grow;
  const pcx = (pt.L[0] + pt.R[0]) / 2, pcy = (pt.L[1] + pt.R[1]) / 2;
  const [fx, fy] = project(pl.x + pl.w / 2, pl.y + pl.d / 2);
  return { x: fx - pcx * scale, y: fy - pcy * scale, scale, width: sprite.width * scale, height: sprite.height * scale, depth: pl.x + pl.w - 1 + pl.y + pl.d - 1 + 0.6 };
}

function maskAt(sprite: BuiltSprite, pl: Placement, W: number, H: number): Uint8Array {
  const m = new Uint8Array(W * H);
  const iw = Math.max(1, Math.round(pl.width)), ih = Math.max(1, Math.round(pl.height));
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const sx = Math.min(sprite.width - 1, Math.floor((x / pl.scale) || 0));
    const sy = Math.min(sprite.height - 1, Math.floor((y / pl.scale) || 0));
    if (sprite.data[(sy * sprite.width + sx) * 4 + 3] <= 128) continue;
    const dx = Math.round(pl.x) + x, dy = Math.round(pl.y) + y;
    if (dx >= 0 && dy >= 0 && dx < W && dy < H) m[dy * W + dx] = 1;
  }
  return m;
}

/** Hidden share per building, prototype `occlusion` logic at TW=90. */
export function occlusion(world: { sprites: BuiltSprite[]; layout: { placed: Placed[]; trees: Placed[] } }, TW = 90): { name: string; isl: string; pct: number }[] {
  const { width: W, height: H } = projector(TW);
  const all = [...world.layout.placed, ...world.layout.trees];
  const masks = all.map((pl) => maskAt(world.sprites[pl.bi], spritePlacement(pl, world.sprites[pl.bi], TW), W, H));
  const order = all.map((p, k) => ({ k, d: p.x + p.w - 1 + p.y + p.d - 1 })).sort((a, b) => a.d - b.d).map((o) => o.k);
  const res: { name: string; isl: string; pct: number }[] = [];
  order.forEach((k, idx) => {
    if (all[k].tree) return;
    const m = masks[k];
    let own = 0, hid = 0;
    const front = order.slice(idx + 1).map((j) => masks[j]);
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      own++;
      for (const f of front) if (f[i]) { hid++; break; }
    }
    res.push({ name: world.sprites[all[k].bi].name, isl: all[k].isl, pct: own ? (hid / own) * 100 : 0 });
  });
  return res.sort((a, b) => b.pct - a.pct);
}
