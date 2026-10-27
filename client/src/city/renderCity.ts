import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import bridgeUrl from "../../../assets/sprites/bridge.png";
import type { World } from "../map/pipeline";
import { coastTileIndexWith } from "../map/coast";
import { pixelsToCanvas } from "../map/renderPixi";
import { TWBASE } from "../map/tileFit";
import { bridgeSpan, cityBridgeDeck, cityProjector, hashSeed, PLOT, plotDepth, type CityLayout } from "./layoutCity";
import type { SessionView } from "../events/reduce";

const BUILDING_SPRITE: Record<string, string> = {
  keep: "keep",
  sea_gate: "gate",
  silos: "silos",
  lighthouse: "lighthouse",
  market: "market",
  containers: "containers",
  ruin: "ruin",
  cottage: "cottage",
  construction: "construction",
};

export class CityView {
  readonly app = new Application();
  private ship!: Sprite;
  private glow = new Graphics();
  private construction!: Sprite;
  private shipTarget: [number, number] | null = null;
  private shipPlaced = false;
  private layout: CityLayout;
  private proj: ReturnType<typeof cityProjector>;
  private world: World;
  private texCache = new Map<string, Texture | null>();
  private root!: Container;
  private cam = { scale: 1, x: 0, y: 0 };
  private fitScale = 1;
  private bridgeGfx!: Graphics;
  private bridgeSprites = new Container();
  private bridgeTex: Texture | null = null;
  private pulseGfx!: Graphics;
  private zoomLevel: "map" | "island" = "map";
  private bridgePairs: {
    count: number;
    span: [{ gx: number; gy: number }, { gx: number; gy: number }];
    deck: ReturnType<typeof cityBridgeDeck>;
    dirs: [{ gx: number; gy: number }, { gx: number; gy: number }][];
  }[] = [];

  constructor(world: World, layout: CityLayout) {
    this.world = world;
    this.layout = layout;
    this.proj = cityProjector(layout, 64);
  }

  private tex(key: string): Texture | null {
    if (!this.texCache.has(key)) {
      const sprite = this.world.sprites.find((s) => s.key === key) ?? this.world.sprites.find((s) => s.key === "cottage");
      this.texCache.set(key, sprite ? Texture.from(pixelsToCanvas(sprite)) : null);
    }
    return this.texCache.get(key) ?? null;
  }

  private toScreen(wx: number, wy: number): [number, number] {
    return [wx * this.cam.scale + this.cam.x, wy * this.cam.scale + this.cam.y];
  }

  /** Screen position of a file's plot centre (for tests and labels). */
  fileScreenPos(file: string): [number, number] | null {
    const pos = this.layout.filePos.get(file);
    if (!pos) return null;
    const [wx, wy] = this.proj.project(pos.gx + PLOT / 2, pos.gy + PLOT / 2);
    return this.toScreen(wx, wy);
  }

  shipScreenPos(): [number, number] {
    return this.toScreen(this.ship.position.x, this.ship.position.y);
  }

  get cameraScale(): number {
    return this.cam.scale;
  }

  private applyCam(): void {
    this.root.position.set(this.cam.x, this.cam.y);
    this.root.scale.set(this.cam.scale);
    // D-zoom: past 2x fit the map becomes the island view. Bridge
    // treatment and direction pulses follow the level.
    const level = this.cam.scale > this.fitScale * 2 ? "island" : "map";
    if (level !== this.zoomLevel) {
      this.zoomLevel = level;
      if (this.bridgeGfx) this.drawBridges();
    }
  }

  /** Bridges by zoom level (D-zoom): at map zoom only strong pairs
   * (15+ imports, pinned from the GestiKo distribution: 24 of 381
   * pairs, 41% of imports) draw. At island zoom every pair draws.
   * Drawn pairs use the bridge sprite (assets/sprites/bridge.png,
   * owner pick run 1): segments repeat along the span and turn to
   * the span angle. The sprite angle is fixed, so long spans in
   * other directions are an approximation, not true perspective.
   * Fallback with no texture: the old deck polygon / stroke. */
  private drawBridges(): void {
    const g = this.bridgeGfx;
    const proj = this.proj;
    g.clear();
    for (const child of this.bridgeSprites.removeChildren()) child.destroy();
    for (const pair of this.bridgePairs) {
      const strong = pair.count >= 15;
      if (this.zoomLevel === "map" && !strong) continue;
      const [ax, ay] = proj.project(pair.span[0].gx, pair.span[0].gy);
      const [bx, by] = proj.project(pair.span[1].gx, pair.span[1].gy);
      if (this.bridgeTex && strong) {
        const tex = this.bridgeTex;
        const len = Math.hypot(bx - ax, by - ay);
        const [c0, c3] = [pair.deck.corners[0], pair.deck.corners[3]].map((c) => proj.project(c.gx, c.gy));
        const deckW = Math.max(14, Math.hypot(c3[0] - c0[0], c3[1] - c0[1]));
        // The deck axis in the source image runs lower-left to
        // upper-right, about half the image height over its width.
        const axisAngle = Math.atan2(-tex.height * 0.52, tex.width);
        const axisLen = Math.hypot(tex.width, tex.height * 0.52);
        // Scale so the sprite's width across the span matches the
        // deck width, then repeat segments along the span. Sizing
        // from the span length made decks far too wide.
        const across = tex.width * Math.abs(Math.sin(axisAngle)) + tex.height * Math.abs(Math.cos(axisAngle));
        const scale = (deckW * 2.6) / across;
        const segs = Math.min(28, Math.max(1, Math.ceil(len / (axisLen * scale * 0.7))));
        const angle = Math.atan2(by - ay, bx - ax);
        for (let s = 0; s < segs; s++) {
          const tm = (s + 0.5) / segs;
          const spr = new Sprite(tex);
          spr.anchor.set(0.5, 0.55);
          spr.position.set(ax + (bx - ax) * tm, ay + (by - ay) * tm);
          spr.rotation = angle - axisAngle;
          spr.scale.set(scale);
          this.bridgeSprites.addChild(spr);
        }
      } else if (strong) {
        const corners = pair.deck.corners.map((c) => proj.project(c.gx, c.gy)).flat();
        g.poly(corners);
        g.fill({ color: 0xb98652, alpha: 0.92 });
        const [c0, c1, c2, c3] = pair.deck.corners.map((c) => proj.project(c.gx, c.gy));
        g.moveTo(c0[0], c0[1]); g.lineTo(c1[0], c1[1]);
        g.moveTo(c3[0], c3[1]); g.lineTo(c2[0], c2[1]);
        g.stroke({ color: 0x7a5432, width: 2, alpha: 0.9 });
      } else {
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke({ color: 0xcfa06a, alpha: 0.5, width: 2 });
      }
    }
  }

  /** Direction glow: a soft light runs on the bridge itself, from
   * the importing island toward the imported island, with a short
   * fading tail. Island zoom only. This is a reading aid, not an
   * agent signal (DESIGN.md stillness rule: noted as a departure
   * in the PR for owner judgement). */
  private drawPulses(nowMs: number): void {
    const g = this.pulseGfx;
    if (!g) return;
    g.clear();
    if (this.zoomLevel !== "island") return;
    const TW = 64;
    const at = (span: { gx: number; gy: number }[], t: number): [number, number] =>
      this.proj.project(span[0].gx + (span[1].gx - span[0].gx) * t, span[0].gy + (span[1].gy - span[0].gy) * t);
    let i = 0;
    for (const pair of this.bridgePairs) {
      if (pair.count < 15) continue; // glow runs on real decks only
      for (const span of pair.dirs) {
        i++;
        const t = ((nowMs / 5000) + i * 0.37) % 1;
        const tail = Math.max(0, t - 0.16);
        const [tx, ty] = at(span, tail);
        const [hx, hy] = at(span, t);
        g.moveTo(tx, ty);
        g.lineTo(hx, hy);
        g.stroke({ color: 0xffd98a, width: TW * 0.1, alpha: 0.22 });
        for (let k = 5; k >= 1; k--) {
          const tk = t - k * 0.028;
          if (tk < 0) continue;
          const [px, py] = at(span, tk);
          g.circle(px, py, TW * (0.085 - k * 0.008));
          g.fill({ color: 0xffe3a3, alpha: 0.1 + (5 - k) * 0.09 });
        }
        g.circle(hx, hy, TW * 0.17);
        g.fill({ color: 0xffd98a, alpha: 0.16 });
        g.circle(hx, hy, TW * 0.075);
        g.fill({ color: 0xfff2c4, alpha: 0.95 });
      }
    }
  }

  private fitCamera(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.fitScale = Math.min(w / this.proj.width, h / this.proj.height);
    this.cam.scale = this.fitScale;
    this.cam.x = (w - this.proj.width * this.cam.scale) / 2;
    this.cam.y = (h - this.proj.height * this.cam.scale) / 2;
    this.applyCam();
  }

  /** Keep at least a corner of the world on screen while panning. */
  private clampPan(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const keep = 120;
    this.cam.x = Math.min(w - keep, Math.max(keep - this.proj.width * this.cam.scale, this.cam.x));
    this.cam.y = Math.min(h - keep, Math.max(keep - this.proj.height * this.cam.scale, this.cam.y));
  }

  get shipVisible(): boolean {
    return this.ship.visible;
  }

  async init(): Promise<HTMLElement> {
    const { TW } = { TW: 64 };
    const proj = this.proj;
    await this.app.init({
      width: window.innerWidth || proj.width,
      height: window.innerHeight || proj.height,
      background: 0x4f98a6,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    const root = new Container();
    this.root = root;
    this.app.stage.addChild(root);
    this.fitCamera();
    // Camera: geometric pan/zoom toward DESIGN.md's zoom levels
    // (semantic level switching is T12). Wheel zooms to the cursor,
    // drag pans, double-click returns to the fitted map view.
    const el = this.app.canvas as unknown as HTMLCanvasElement;
    el.style.touchAction = "none";
    let userMoved = false;
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        userMoved = true;
        const next = Math.min(this.fitScale * 8, Math.max(this.fitScale * 0.9, this.cam.scale * Math.exp(-e.deltaY * 0.0012)));
        const k = next / this.cam.scale;
        this.cam.x = e.offsetX - (e.offsetX - this.cam.x) * k;
        this.cam.y = e.offsetY - (e.offsetY - this.cam.y) * k;
        this.cam.scale = next;
        this.clampPan();
        this.applyCam();
      },
      { passive: false },
    );
    let drag: { x: number; y: number; cx: number; cy: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      userMoved = true;
      drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.cam.x = drag.cx + (e.clientX - drag.x);
      this.cam.y = drag.cy + (e.clientY - drag.y);
      this.clampPan();
      this.applyCam();
    });
    el.addEventListener("pointerup", () => (drag = null));
    el.addEventListener("pointercancel", () => (drag = null));
    el.addEventListener("dblclick", () => {
      userMoved = false;
      this.fitCamera();
    });
    window.addEventListener("resize", () => {
      this.app.renderer.resize(window.innerWidth, window.innerHeight);
      this.fitScale = Math.min(this.app.screen.width / this.proj.width, this.app.screen.height / this.proj.height);
      if (!userMoved) this.fitCamera();
      else {
        this.cam.scale = Math.min(this.fitScale * 8, Math.max(this.fitScale * 0.9, this.cam.scale));
        this.clampPan();
        this.applyCam();
      }
    });
    // Coast tiles (step 1 of the owner-approved order): every land
    // cell picks its fitted tile from which neighbors are water,
    // the spike rule in map/coast.ts. The city used plain grass on
    // every cell before this; the shore now comes from the sheet.
    const tileTexByIndex = this.world.tiles.map((t) => Texture.from(pixelsToCanvas(t)));
    const tileHByIndex = this.world.tiles.map((t) => (t.height * TW) / TWBASE);
    const landSet = new Set<string>();
    for (const isl of this.layout.islands) for (const k of isl.cells) landSet.add(k);
    const cityLand = (gx: number, gy: number): boolean => landSet.has(gx + "," + gy);

    interface Item { depth: number; kind: number; node: Container }
    const items: Item[] = [];

    // island ground: coast-fitted tiles on every land cell of the
    // island's organic outline (layoutCity.islandShape)
    for (const isl of this.layout.islands) {
      const cells = [...isl.cells]
        .map((k) => k.split(",").map(Number) as [number, number])
        .sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
      for (const [gx, gy] of cells) {
        const ti = coastTileIndexWith(cityLand, gx, gy);
        const s = new Sprite(tileTexByIndex[ti]);
        const [tx, ty] = proj.project(gx, gy);
        s.position.set(tx - TW / 2, ty);
        s.width = TW;
        s.height = tileHByIndex[ti];
        const c = new Container();
        c.addChild(s);
        items.push({ depth: gx + gy, kind: 0, node: c });
      }
    }

    // shoreline: shallow halo under every island (DESIGN.md:
    // shallow water is drawn in code under the tiles). The halo
    // follows the island outline: the land mask grown by one cell.
    // The sand edge itself comes from the coast tiles.
    const shore = new Graphics();
    for (const isl of this.layout.islands) {
      const grown = new Set<string>();
      for (const k of isl.cells) {
        const [gx, gy] = k.split(",").map(Number);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) grown.add(gx + dx + "," + (gy + dy));
      }
      for (const k of grown) {
        const [gx, gy] = k.split(",").map(Number);
        const [tx, ty] = proj.project(gx, gy);
        shore.poly([tx, ty - TW / 4, tx + TW / 2, ty, tx, ty + TW / 4, tx - TW / 2, ty]);
        shore.fill({ color: 0x8fd8cf, alpha: 0.28 });
      }
    }
    // Cliffs (step 2, owner fix): not every shore is a cliff. A
    // front edge gets a rock face only where the land behind it is
    // thick (distance-to-water of the cell behind the edge >= 2):
    // headlands get cliffs, thin shores stay beach. Face height
    // grows with that thickness, capped. Drawn in code like the
    // sea and bridges; the coast sheet holds no cliff tiles.
    const landDist = new Map<string, number>();
    {
      let frontier: string[] = [];
      for (const k of landSet) {
        const [gx, gy] = k.split(",").map(Number);
        if (!cityLand(gx + 1, gy) || !cityLand(gx - 1, gy) || !cityLand(gx, gy + 1) || !cityLand(gx, gy - 1)) {
          landDist.set(k, 0);
          frontier.push(k);
        }
      }
      let d = 0;
      while (frontier.length && d < 4) {
        const next: string[] = [];
        for (const k of frontier) {
          const [gx, gy] = k.split(",").map(Number);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nk = gx + dx + "," + (gy + dy);
            if (cityLand(gx + dx, gy + dy) && !landDist.has(nk)) {
              landDist.set(nk, d + 1);
              next.push(nk);
            }
          }
        }
        frontier = next;
        d++;
      }
    }
    const cliffBase = TW * 0.38;
    for (const isl of this.layout.islands) {
      for (const key of isl.cells) {
        const [gx, gy] = key.split(",").map(Number);
        const [tx, ty] = proj.project(gx, gy);
        const left: [number, number] = [tx - TW / 2, ty + TW / 4];
        const bottom: [number, number] = [tx, ty + TW / 2];
        const right: [number, number] = [tx + TW / 2, ty + TW / 4];
        if (!cityLand(gx, gy + 1)) {
          const behind = landDist.get(gx + "," + (gy - 1)) ?? 0;
          if (behind >= 2) {
            const cliffH = cliffBase * (0.7 + 0.2 * Math.min(behind, 3));
            shore.poly([left[0], left[1], bottom[0], bottom[1], bottom[0], bottom[1] + cliffH, left[0], left[1] + cliffH]);
            shore.fill({ color: 0x7d7468, alpha: 1 });
          }
        }
        if (!cityLand(gx + 1, gy)) {
          const behind = landDist.get(gx - 1 + "," + gy) ?? 0;
          if (behind >= 2) {
            const cliffH = cliffBase * (0.7 + 0.2 * Math.min(behind, 3));
            shore.poly([bottom[0], bottom[1], right[0], right[1], right[0], right[1] + cliffH, bottom[0], bottom[1] + cliffH]);
            shore.fill({ color: 0x6b6156, alpha: 1 });
          }
        }
      }
    }
    root.addChild(shore);

    // Bridge data: one entry per unordered island pair, with one
    // oriented span per import direction for the pulses.
    const byId = new Map(this.layout.islands.map((i) => [i.id, i]));
    {
      const pairs = new Map<string, { count: number; dirs: CityLayout["bridges"] }>();
      for (const br of this.layout.bridges) {
        const key = [br.from, br.to].sort().join("|");
        const pair = pairs.get(key) ?? { count: 0, dirs: [] };
        pair.count = Math.max(pair.count, br.count);
        pair.dirs.push(br);
        pairs.set(key, pair);
      }
      for (const pair of pairs.values()) {
        const br = pair.dirs[0];
        const a = byId.get(br.from);
        const b = byId.get(br.to);
        if (!a || !b) continue;
        const span = bridgeSpan(
          { x: a.x, y: a.y, w: a.cols * PLOT, h: a.rows * PLOT },
          { x: b.x, y: b.y, w: b.cols * PLOT, h: b.rows * PLOT },
        );
        if (!span) continue;
        this.bridgePairs.push({
          count: pair.count,
          span,
          deck: cityBridgeDeck(span, pair.count),
          dirs: pair.dirs.map((dir) => (dir.from === br.from ? span : [span[1], span[0]] as typeof span)),
        });
      }
    }
    this.bridgeTex = (await Assets.load(bridgeUrl).catch(() => null)) as Texture | null;
    this.bridgeGfx = new Graphics();
    this.pulseGfx = new Graphics();
    root.addChild(this.bridgeSprites);
    root.addChild(this.bridgeGfx);
    this.drawBridges();

    // buildings, one sprite per file, placed by its plate footprint
    const drawnTestIslets = new Set<string>();
    for (const b of this.layout.buildings) {
      if (b.building === "pennant") {
        // A test-only islet draws one pennant for the whole island;
        // its count is in the label. 103 flags said nothing.
        const home = this.layout.islands.find((i) => i.id === b.islandId);
        if (home?.testOnly) {
          if (drawnTestIslets.has(home.id)) continue;
          drawnTestIslets.add(home.id);
        }
        // Test files are not buildings (DESIGN.md): a small flag on
        // a pole at the plot centre, in the island's depth order.
        const [fx, fy] = proj.project(b.gx + PLOT / 2, b.gy + PLOT / 2);
        const g = new Graphics();
        g.moveTo(fx, fy);
        g.lineTo(fx, fy - TW * 0.55);
        g.stroke({ color: 0x7a5432, width: Math.max(1, TW * 0.03) });
        g.poly([fx, fy - TW * 0.55, fx + TW * 0.34, fy - TW * 0.44, fx, fy - TW * 0.33]);
        g.fill({ color: 0xe8cf92 });
        const c = new Container();
        c.addChild(g);
        items.push({ depth: plotDepth(b.gx, b.gy), kind: 1, node: c });
        continue;
      }
      let key = BUILDING_SPRITE[b.building] ?? "cottage";
      // Cottages vary: one in three takes the slate-roof sprite,
      // by file hash, so a village is not one stamped house.
      if (key === "cottage" && hashSeed(b.file) % 3 === 0) key = "slate";
      const sprite = this.world.sprites.find((s) => s.key === key) ?? this.world.sprites.find((s) => s.key === "cottage");
      const texture = this.tex(key);
      if (!sprite || !texture || !sprite.plate) continue;
      const pt = sprite.plate;
      const unit = Math.hypot(TW / 2, TW / 4);
      const grow = Math.min(1.5, 0.92 / pt.reach);
      const scale =
        Math.min(
          (sprite.foot[0] * unit) / Math.hypot(pt.B[0] - pt.L[0], pt.B[1] - pt.L[1]),
          (sprite.foot[1] * unit) / Math.hypot(pt.R[0] - pt.B[0], pt.R[1] - pt.B[1]),
        ) * grow;
      const pcx = (pt.L[0] + pt.R[0]) / 2;
      const pcy = (pt.L[1] + pt.R[1]) / 2;
      const [fx, fy] = proj.project(b.gx + PLOT / 2, b.gy + PLOT / 2);
      const s = new Sprite(texture);
      s.width = sprite.width * scale;
      s.height = sprite.height * scale;
      s.position.set(fx - pcx * scale, fy - pcy * scale);
      const c = new Container();
      c.addChild(s);
      items.push({ depth: plotDepth(b.gx, b.gy), kind: 1, node: c });
    }

    // Inland life: trees on free inner land cells. Free means no
    // building plot and not shore (landDist >= 1). Seeded by cell,
    // sparse, capped per island. There is no mountain sprite in
    // the sheets; trees and the boulder are what the art holds
    // today, so mountains wait for a sprite-pipeline sheet.
    {
      const treeSprite = this.world.sprites.find((s) => s.key === "tree");
      const treeTex = this.tex("tree");
      if (treeSprite?.plate && treeTex) {
        const pt = treeSprite.plate;
        const unit = Math.hypot(TW / 2, TW / 4);
        const scale = Math.min(
          unit / Math.hypot(pt.B[0] - pt.L[0], pt.B[1] - pt.L[1]),
          unit / Math.hypot(pt.R[0] - pt.B[0], pt.R[1] - pt.B[1]),
        );
        const pcx = (pt.L[0] + pt.R[0]) / 2;
        const pcy = (pt.L[1] + pt.R[1]) / 2;
        const occupied = new Set<string>();
        for (const b of this.layout.buildings) {
          if (b.building === "pennant") occupied.add(b.gx + "," + b.gy);
          else for (let dy = 0; dy < PLOT; dy++) for (let dx = 0; dx < PLOT; dx++) occupied.add(b.gx + dx + "," + (b.gy + dy));
        }
        for (const isl of this.layout.islands) {
          let placedTrees = 0;
          const cap = Math.max(1, Math.floor(isl.cells.size / 14));
          for (const key of isl.cells) {
            if (placedTrees >= cap) break;
            if (occupied.has(key)) continue;
            const [gx, gy] = key.split(",").map(Number);
            if ((landDist.get(key) ?? 0) < 1) continue;
            const h = Math.abs(Math.sin(gx * 127.1 + gy * 311.7 + isl.x * 17.3) * 43758.5453) % 1;
            if (h > 0.16) continue;
            const [fx, fy] = proj.project(gx + 0.5, gy + 0.5);
            const s = new Sprite(treeTex);
            s.width = treeSprite.width * scale;
            s.height = treeSprite.height * scale;
            s.position.set(fx - pcx * scale, fy - pcy * scale);
            const c = new Container();
            c.addChild(s);
            items.push({ depth: gx + gy + 0.5, kind: 1, node: c });
            placedTrees++;
          }
        }
      }
    }

    items.sort((a, b) => a.depth - b.depth || a.kind - b.kind).forEach((it) => root.addChild(it.node));

    // island labels
    for (const isl of this.layout.islands) {
      const [lx, ly] = proj.project(isl.center.gx, isl.y + isl.rows * PLOT + 0.7);
      const t = new Text({
        text: isl.testOnly
          ? `${isl.name} · ${isl.testCount} tests`
          : `${isl.name} · ${this.layout.buildings.filter((b) => b.islandId === isl.id).length}`,
        style: { fontFamily: "\"Bricolage Grotesque\", sans-serif", fontWeight: "800", fontSize: 20, fill: 0xffffff, stroke: { color: 0x14323c, width: 4, alpha: 0.55 } },
      });
      t.anchor.set(0.5, 0);
      t.position.set(lx, ly);
      root.addChild(t);
    }

    root.addChild(this.pulseGfx);

    // construction overlay on the building being edited
    const constructionTex = this.tex("construction");
    this.construction = new Sprite(constructionTex ?? Texture.EMPTY);
    this.construction.visible = false;
    this.construction.width = TW * 1.4;
    this.construction.height = TW * 1.4;
    root.addChild(this.construction);

    root.addChild(this.glow);

    // the session ship
    const shipTex = Texture.from(pixelsToCanvas(this.world.ship));
    this.ship = new Sprite(shipTex);
    // No event has pointed anywhere yet: the ship is not drawn at
    // an invented gate. It appears when a real event places it.
    this.ship.visible = false;
    const sc = (TW * 1.5) / this.world.ship.width;
    this.ship.width = this.world.ship.width * sc;
    this.ship.height = this.world.ship.height * sc;
    this.ship.anchor.set(0.5, 0.85);
    root.addChild(this.ship);

    // sail toward the target every frame; motion follows events only
    this.app.ticker.add((time) => {
      this.drawPulses(time.lastTime);
      if (!this.shipTarget) return;
      const [tx, ty] = this.shipTarget;
      this.ship.position.x += (tx - this.ship.position.x) * 0.07;
      this.ship.position.y += (ty - this.ship.position.y) * 0.07;
    });

    return this.app.canvas as unknown as HTMLElement;
  }

  /** Reflect the reduced session view: lit buildings, ship, markers. */
  update(view: SessionView): void {
    const proj = this.proj;
    const TW = 64;
    this.glow.clear();
    for (const file of view.litFiles) {
      const pos = this.layout.filePos.get(file);
      if (!pos) continue;
      const [cx, cy] = proj.project(pos.gx + PLOT / 2, pos.gy + PLOT / 2);
      this.glow.moveTo(cx, cy - TW / 2);
      this.glow.lineTo(cx + TW, cy);
      this.glow.lineTo(cx, cy + TW / 2);
      this.glow.lineTo(cx - TW, cy);
      this.glow.closePath();
      this.glow.fill({ color: 0xf6c85f, alpha: 0.45 });
    }
    // No fallback island: markers only appear where an event
    // actually pointed. Unknown stays unknown.
    const island = this.layout.islands.find((i) => i.id === view.shipIsland);
    if (view.locationUnknown && island) {
      const [gx, gy] = proj.project(island.gate.gx + 1, island.gate.gy + 1);
      this.glow.circle(gx, gy, TW * 0.5);
      this.glow.stroke({ color: 0xd4402b, width: 4 });
    }
    if (view.testPassed !== null && island) {
      const [cx, cy] = proj.project(island.center.gx, island.center.gy);
      this.glow.moveTo(cx, cy - TW * 1.6);
      this.glow.lineTo(cx + TW * 0.55, cy - TW * 1.3);
      this.glow.lineTo(cx, cy - TW);
      this.glow.closePath();
      this.glow.fill({ color: view.testPassed ? 0x3e9a5b : 0xd4402b, alpha: 0.95 });
    }
    // ship target: the touched building, else the island gate —
    // only when an event named an island. Otherwise no target and
    // the ship stays hidden rather than invented somewhere.
    const filePos = view.shipFile ? this.layout.filePos.get(view.shipFile) : undefined;
    if (filePos) {
      const [tx, ty] = proj.project(filePos.gx + PLOT / 2, filePos.gy + PLOT + 0.4);
      this.shipTarget = [tx, ty];
      this.construction.visible = view.state === "working";
      this.construction.position.set(tx - TW * 0.7, ty - TW * 1.5);
    } else if (island) {
      const [tx, ty] = proj.project(island.gate.gx + 1, island.gate.gy + island.rows * PLOT + 0.6);
      this.shipTarget = [tx, ty];
      this.construction.visible = false;
    } else {
      this.shipTarget = null;
      this.construction.visible = false;
    }
    if (this.shipTarget) {
      this.ship.visible = true;
      if (!this.shipPlaced) {
        this.ship.position.set(this.shipTarget[0], this.shipTarget[1]);
        this.shipPlaced = true;
      }
    } else {
      this.ship.visible = false;
    }
  }
}
