import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { World } from "../map/pipeline";
import { PLAIN_GRASS_INDEX } from "../map/coast";
import { pixelsToCanvas } from "../map/renderPixi";
import { TWBASE } from "../map/tileFit";
import { bridgeChevron, bridgeSpan, cityBridgeDeck, cityProjector, PLOT, plotDepth, type CityLayout } from "./layoutCity";
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
    const tileTex = Texture.from(pixelsToCanvas(this.world.tiles[PLAIN_GRASS_INDEX]));
    const tileH = (this.world.tiles[PLAIN_GRASS_INDEX].height * TW) / TWBASE;

    interface Item { depth: number; kind: number; node: Container }
    const items: Item[] = [];

    // island ground: plain-grass fitted tiles on every island cell
    for (const isl of this.layout.islands) {
      for (let gy = isl.y; gy < isl.y + isl.rows * PLOT; gy++) {
        for (let gx = isl.x; gx < isl.x + isl.cols * PLOT; gx++) {
          const s = new Sprite(tileTex);
          const [tx, ty] = proj.project(gx, gy);
          s.position.set(tx - TW / 2, ty);
          s.width = TW;
          s.height = tileH;
          const c = new Container();
          c.addChild(s);
          items.push({ depth: gx + gy, kind: 0, node: c });
        }
      }
    }

    // shoreline: shallow halo and a sand edge under every island
    // (DESIGN.md: shallow water is drawn in code under the tiles)
    const shore = new Graphics();
    for (const isl of this.layout.islands) {
      const w = isl.cols * PLOT;
      const h = isl.rows * PLOT;
      const ring = (e: number): number[] => [
        ...proj.project(isl.x - e, isl.y - e),
        ...proj.project(isl.x + w + e, isl.y - e),
        ...proj.project(isl.x + w + e, isl.y + h + e),
        ...proj.project(isl.x - e, isl.y + h + e),
      ];
      shore.poly(ring(1.3));
      shore.fill({ color: 0x8fd8cf, alpha: 0.4 });
      shore.poly(ring(0.45));
      shore.fill({ color: 0xe8cf92, alpha: 0.9 });
    }
    root.addChild(shore);

    // Bridges are decks, not lines: the same code-drawn bridge as
    // the test map (side face, plank seams, posts, rope rails),
    // generalised to a diagonal shore-to-shore span. A lane-gold
    // chevron near the far end points along the import direction.
    const byId = new Map(this.layout.islands.map((i) => [i.id, i]));
    const bridges = new Graphics();
    const deckList: { span: [{ gx: number; gy: number }, { gx: number; gy: number }]; deck: ReturnType<typeof cityBridgeDeck> }[] = [];
    // One deck per unordered island pair, at the wider direction's
    // width; each direction still gets its own chevron later.
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
      const deck = cityBridgeDeck(span, pair.count);
      const P = (gx: number, gy: number, z = 0): [number, number] => {
        const [x, y] = proj.project(gx, gy);
        return [x, y - z * TW];
      };
      const at = (t: number, v: number, z = 0): [number, number] =>
        P(
          deck.a.gx + (deck.b.gx - deck.a.gx) * t + deck.perp.gx * v,
          deck.a.gy + (deck.b.gy - deck.a.gy) * t + deck.perp.gy * v,
          z,
        );
      const c = deck.corners.map((pt) => P(pt.gx, pt.gy));
      // side face on whichever edge faces the viewer (lower on screen)
      const front = (c[2][1] + c[3][1]) / 2 > (c[0][1] + c[1][1]) / 2 ? [c[3], c[2]] : [c[1], c[0]];
      bridges.poly([front[0][0], front[0][1], front[1][0], front[1][1], front[1][0], front[1][1] + TW * 0.1, front[0][0], front[0][1] + TW * 0.1]);
      bridges.fill({ color: 0x7a5432 });
      // posts below the deck edges
      for (let s = 0.5; s < deck.len; s += 1) {
        for (const v of [-1, 1]) {
          const p = at(s / deck.len, v);
          bridges.moveTo(p[0], p[1]);
          bridges.lineTo(p[0], p[1] + TW * 0.22);
        }
      }
      bridges.stroke({ color: 0x5b3e25, width: Math.max(1, TW * 0.03) });
      // deck top and plank seams
      bridges.poly([...c[0], ...c[1], ...c[2], ...c[3]]);
      bridges.fill({ color: 0xb98652 });
      for (let s = 0.12; s < deck.len; s += 0.24) {
        const p = at(s / deck.len, -1);
        const q2 = at(s / deck.len, 1);
        bridges.moveTo(p[0], p[1]);
        bridges.lineTo(q2[0], q2[1]);
      }
      bridges.stroke({ color: 0x5a3c1e, alpha: 0.5, width: Math.max(1, TW / 90) });
      // rope rails: posts up, sagging rope between them. The post
      // spacing divides the span evenly so the last post lands on
      // the far shore instead of hanging mid-sag.
      const railSteps = Math.max(1, Math.round(deck.len / 0.7));
      const railStep = deck.len / railSteps;
      for (const v of [-1, 1]) {
        for (let i = 0; i <= railSteps; i++) {
          const p = at(i / railSteps, v);
          const q2 = at(i / railSteps, v, 0.11);
          bridges.moveTo(p[0], p[1]);
          bridges.lineTo(q2[0], q2[1]);
        }
        bridges.stroke({ color: 0x5b3e25, width: Math.max(1, TW * 0.022) });
        let first = true;
        for (let s = 0; s <= deck.len + 1e-6; s += 0.07) {
          const sag = 0.025 * Math.sin(((s % railStep) / railStep) * Math.PI);
          const p = at(Math.min(1, s / deck.len), v, 0.1 - sag);
          if (first) {
            bridges.moveTo(p[0], p[1]);
            first = false;
          } else bridges.lineTo(p[0], p[1]);
        }
        const end = at(1, v, 0.1);
        bridges.lineTo(end[0], end[1]);
        bridges.stroke({ color: 0xd9c08c, width: Math.max(1, TW / 80) });
      }
      for (const dir of pair.dirs) {
        deckList.push({ span: dir.from === br.from ? span : [span[1], span[0]], deck });
      }
    }
    root.addChild(bridges);

    // buildings, one sprite per file, placed by its plate footprint
    for (const b of this.layout.buildings) {
      const key = BUILDING_SPRITE[b.building] ?? "cottage";
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

    items.sort((a, b) => a.depth - b.depth || a.kind - b.kind).forEach((it) => root.addChild(it.node));

    // Direction chevrons last among the static layers, so a
    // shoreline arrow is not buried under the island it points at.
    const chevrons = new Graphics();
    for (const { span, deck } of deckList) {
      const ch = bridgeChevron(span, deck);
      const tip = proj.project(ch.tip.gx, ch.tip.gy);
      const wa = proj.project(ch.wingA.gx, ch.wingA.gy);
      const wb = proj.project(ch.wingB.gx, ch.wingB.gy);
      chevrons.moveTo(wa[0], wa[1]);
      chevrons.lineTo(tip[0], tip[1]);
      chevrons.lineTo(wb[0], wb[1]);
    }
    chevrons.stroke({ color: 0xffe3a3, width: Math.max(1.5, TW * 0.045), alpha: 0.95 });
    root.addChild(chevrons);

    // island labels
    for (const isl of this.layout.islands) {
      const [lx, ly] = proj.project(isl.center.gx, isl.y + isl.rows * PLOT + 0.7);
      const t = new Text({
        text: `${isl.name} · ${this.layout.buildings.filter((b) => b.islandId === isl.id).length}`,
        style: { fontFamily: "\"Bricolage Grotesque\", sans-serif", fontWeight: "800", fontSize: 20, fill: 0xffffff, stroke: { color: 0x14323c, width: 4, alpha: 0.55 } },
      });
      t.anchor.set(0.5, 0);
      t.position.set(lx, ly);
      root.addChild(t);
    }

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
    this.app.ticker.add(() => {
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
