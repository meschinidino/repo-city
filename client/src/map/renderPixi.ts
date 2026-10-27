import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { PixelData } from "./pixels";
import type { World } from "./pipeline";
import { projector, land, COLS, ROWS, ISLANDS, BRIDGES, SHIPS, LANE } from "./world";
import { coastTileIndex } from "./coast";
import { spritePlacement } from "./placement";
import { bridgeDeck } from "./drawGeometry";
import { TWBASE } from "./tileFit";

export function pixelsToCanvas(p: PixelData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = p.width; c.height = p.height;
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return c;
}
function tex(p: PixelData): Texture {
  return Texture.from(pixelsToCanvas(p));
}
function poly(g: Graphics, pts: [number, number][], fill: number, alpha = 1) {
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath(); g.fill({ color: fill, alpha });
}

/** Render the same three-island test map as the prototype, in Pixi. TW=200 is full size. */
export async function renderWorld(world: World, TW = 200): Promise<Application> {
  const proj = projector(TW);
  const app = new Application();
  await app.init({ width: proj.width, height: proj.height, background: 0x4f98a6, antialias: true, resolution: 1 });
  const root = new Container();
  app.stage.addChild(root);
  const thick = world.medianThick * TW;

  // sea: vertical gradient #5FA8B4 -> #3A8496 in bands, plus the prototype's wave strokes
  const sea = new Graphics();
  const top = [0x5f, 0xa8, 0xb4], bot = [0x3a, 0x84, 0x96];
  const BANDS = 32;
  for (let i = 0; i < BANDS; i++) {
    const t0 = i / BANDS;
    const col = top.map((v, k) => Math.round(v + (bot[k] - v) * t0));
    sea.rect(0, (proj.height * i) / BANDS, proj.width, proj.height / BANDS + 1);
    sea.fill({ color: (col[0] << 16) | (col[1] << 8) | col[2] });
  }
  for (let i = 0; i < 140; i++) {
    const px = ((i * 137 % 97) / 97) * proj.width, py = ((i * 71 % 89) / 89) * proj.height;
    sea.moveTo(px, py);
    sea.quadraticCurveTo(px + TW * 0.08, py - TW * 0.03, px + TW * 0.16, py);
    sea.stroke({ color: 0xffffff, alpha: 0.16, width: Math.max(1, TW / 60) });
  }
  root.addChild(sea);

  // shallow-water halos under islands
  const halo = new Graphics();
  for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) {
    if (!land(gx, gy)) continue;
    const pts = ([[gx - 0.3, gy - 0.3], [gx + 1.3, gy - 0.3], [gx + 1.3, gy + 1.3], [gx - 0.3, gy + 1.3]] as [number, number][])
      .map(([x, y]) => { const [px, py] = proj.project(x, y); return [px, py + thick * 0.7] as [number, number]; });
    poly(halo, pts, 0x8fd8cf, 0.2);
  }
  root.addChild(halo);

  interface Item { depth: number; kind: number; node: Container }
  const items: Item[] = [];

  // tiles
  for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) {
    if (!land(gx, gy)) continue;
    const tile = world.tiles[coastTileIndex(gx, gy)];
    const s = new Sprite(tex(tile));
    const [tx, ty] = proj.project(gx, gy);
    s.position.set(tx - TW / 2, ty);
    s.width = TW; s.height = (tile.height * TW) / TWBASE;
    const c = new Container(); c.addChild(s);
    items.push({ depth: gx + gy, kind: 0, node: c });
  }

  // bridges, drawn in code from grid coordinates
  for (const br of BRIDGES) {
    const deck = bridgeDeck(br);
    const g = new Graphics();
    const q = (u: number, v: number, z = 0): [number, number] => {
      const [gx, gy] = deck.alongX ? [u, br.a[1] + v] : [br.a[0] + v, u];
      const [px, py] = proj.project(gx, gy);
      return [px, py - z * TW];
    };
    const hw = 0.22;
    for (let u = deck.u0 + 0.5; u < deck.u1; u += 1) for (const v of [-hw + 0.03, hw - 0.03]) {
      const a = q(u, v), b = q(u, v, -world.medianThick * 0.5);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke({ color: 0x5b3e25, width: TW * 0.035 });
    }
    poly(g, [q(deck.u0, hw), q(deck.u1, hw), q(deck.u1, hw, -0.08), q(deck.u0, hw, -0.08)], 0x7a5432);
    poly(g, [q(deck.u0, -hw), q(deck.u1, -hw), q(deck.u1, hw), q(deck.u0, hw)], 0xb98652);
    for (let u = deck.u0 + 0.12; u < deck.u1; u += 0.12) {
      const a = q(u, -hw), b = q(u, hw);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke({ color: 0x5a3c1e, alpha: 0.55, width: Math.max(1, TW / 90) });
    }
    // rope rails on short posts, sagging between posts (prototype bridge)
    for (const v of [-hw, hw]) {
      for (let u = deck.u0; u <= deck.u1 + 1e-6; u += 0.5) {
        const a = q(u, v), b = q(u, v, 0.11);
        g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke({ color: 0x5b3e25, width: TW * 0.025 });
      }
      let first = true;
      for (let u = deck.u0; u <= deck.u1 + 1e-6; u += 0.05) {
        const sag = 0.025 * Math.sin((((u - deck.u0) % 0.5) / 0.5) * Math.PI);
        const p = q(u, v, 0.1 - sag);
        if (first) { g.moveTo(p[0], p[1]); first = false; } else g.lineTo(p[0], p[1]);
      }
      g.stroke({ color: 0xd9c08c, width: Math.max(1, TW / 80) });
    }
    const c = new Container(); c.addChild(g);
    items.push({ depth: br.a[0] + br.a[1] + 0.2, kind: 0.5, node: c });
  }

  // buildings and trees
  const all = [...world.layout.placed, ...world.layout.trees];
  all.forEach((pl) => {
    const sprite = world.sprites[pl.bi];
    const place = spritePlacement(pl, sprite, TW);
    const s = new Sprite(tex(sprite));
    s.position.set(place.x, place.y);
    s.width = place.width; s.height = place.height;
    const c = new Container(); c.addChild(s);
    items.push({ depth: place.depth, kind: 1, node: c });
  });

  // ships
  for (const [gx, gy] of SHIPS) {
    const wake = new Graphics();
    const [wx, wy0] = proj.project(gx, gy);
    wake.ellipse(wx, wy0 + thick, TW * 0.5, (TW / 2) * 0.22);
    wake.fill({ color: 0xffffff, alpha: 0.3 });
    const wc = new Container(); wc.addChild(wake);
    items.push({ depth: gx + gy - 0.1, kind: 1, node: wc });
    const s = new Sprite(tex(world.ship));
    const [cx, cy0] = proj.project(gx, gy);
    const cy = cy0 + thick;
    const sc = (TW * 0.95) / world.ship.width;
    s.width = world.ship.width * sc; s.height = world.ship.height * sc;
    s.position.set(cx - s.width / 2, cy - s.height * 0.9);
    const c = new Container(); c.addChild(s);
    items.push({ depth: gx + gy, kind: 1, node: c });
  }

  items.sort((a, b) => a.depth - b.depth || a.kind - b.kind).forEach((it) => root.addChild(it.node));

  // dashed gold lane, drawn in code
  const lane = new Graphics();
  const pts = LANE.map(([gx, gy]) => { const [x, y] = proj.project(gx, gy); return [x, y + thick] as [number, number]; });
  for (let i = 0; i < pts.length - 1; i++) {
    // dashed by segment subdivision
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay), dash = TW * 0.14, gap = TW * 0.1;
    for (let d = 0; d < len; d += dash + gap) {
      const t0 = d / len, t1 = Math.min(1, (d + dash) / len);
      lane.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
      lane.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
    }
  }
  lane.stroke({ color: 0xffe3a3, width: TW * 0.045, alpha: 0.95 });
  const laneGlow = new Graphics();
  for (let i = 0; i < pts.length - 1; i++) { laneGlow.moveTo(pts[i][0], pts[i][1]); laneGlow.lineTo(pts[i + 1][0], pts[i + 1][1]); }
  laneGlow.stroke({ color: 0xffd478, width: TW * 0.2, alpha: 0.33 });
  root.addChildAt(laneGlow, root.children.length - 1);
  root.addChild(lane);

  // island labels on the water
  for (const isl of ISLANDS) {
    const [lx, ly] = proj.project(isl.label[0], isl.label[1]);
    const t = new Text({ text: isl.name, style: { fontFamily: "system-ui, sans-serif", fontWeight: "800", fontSize: Math.round(TW * 0.3), fill: 0xffffff, stroke: { color: 0x14323c, width: Math.max(3, TW / 25), alpha: 0.55 } } });
    t.anchor.set(0.5, 0);
    t.position.set(lx, ly);
    root.addChild(t);
  }
  return app;
}
