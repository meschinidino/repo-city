import { Application, Assets, Container, Graphics, MeshSimple, Sprite, Text, Texture } from "pixi.js";
import plankAUrl from "../../../assets/sprites/bridge-plank-a.png";
import plankBUrl from "../../../assets/sprites/bridge-plank-b.png";
import postUrl from "../../../assets/sprites/bridge-post.png";
import glow0Url from "../../../assets/sprites/glow-0.png";
import glow1Url from "../../../assets/sprites/glow-1.png";
import glow2Url from "../../../assets/sprites/glow-2.png";
import type { World } from "../map/pipeline";
import { coastTileIndexWith } from "../map/coast";
import { pixelsToCanvas } from "../map/renderPixi";
import { TWBASE } from "../map/tileFit";
import { bridgeAxisLegs, bridgeSpan, cityBridgeDeck, cityProjector, deckEdges, deckRibbon, deckTargetH, hashSeed, PLOT, plotDepth, studsOnPath, waterSegments, type CityLayout, type RibbonStrip } from "./layoutCity";
import { dashSegments } from "./lane";
import type { SessionView } from "../events/reduce";

/** Rail furniture: posts stamp along both deck edges every
 * POST_SPACING world px (rails stagger by half a spacing), each
 * POST_H_FRAC of the deck width tall; one rope sags between
 * consecutive post tops (ROPE_FRAC up from the post base). */
const POST_SPACING = 22;
const POST_H_FRAC = 0.3;
const ROPE_FRAC = 0.92;
const ROPE_SAG = 3;

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
  private plankTexA: Texture | null = null;
  private plankTexB: Texture | null = null;
  private postTex: Texture | null = null;
  private ropeGfx!: Graphics;
  private postLayer = new Container();
  /** Post range per drawn pair (visual QA isolates one pair). */
  private postRanges: { start: number; count: number }[] = [];
  private glowLayer = new Container();
  private glowTexs: Texture[] = [];
  private glowSprites: { spr: Sprite; points: { gx: number; gy: number }[]; cum: number[]; phase: number }[] = [];
  private landCells = new Set<string>();
  private ring = new Graphics();
  private ringIsland: string | null = null;
  /** Set by the shell: a plain click (not a drag) on the canvas. */
  onCanvasClick: ((sx: number, sy: number) => void) | null = null;
  /** Set by the shell: a lane drag from one island onto another. */
  onLaneDrop: ((fromId: string, toId: string) => void) | null = null;
  private laneGfx: Graphics | null = null;
  /** Committed pending lanes: { source, target } island ids, dashes
   * flowing source -> target (used -> using, the drag direction). */
  private lanes: { source: string; target: string }[] = [];
  /** The lane under confirmation in the quest form, if any. */
  private confirmingLane: { source: string; target: string } | null = null;
  /** A drag in progress: origin island plus cursor in screen px. */
  private previewDrag: { from: string; sx: number; sy: number } | null = null;
  private zoomLevel: "map" | "island" = "map";
  private bridgePairs: {
    count: number;
    span: [{ gx: number; gy: number }, { gx: number; gy: number }];
    deck: ReturnType<typeof cityBridgeDeck>;
    points: { gx: number; gy: number }[];
    clear: boolean;
    dirs: { gx: number; gy: number }[][];
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

  /** Screen legs for a span, in grid points. Straight when the
   * span already runs near a map axis. Else two legs along the two
   * map axes (elbow in grid space). No leg is ever steep on
   * screen, so no deck reads as falling. */
  private spanLegs(span: [{ gx: number; gy: number }, { gx: number; gy: number }]): [{ gx: number; gy: number }, { gx: number; gy: number }][] {
    const [a, b] = span;
    const ax = Math.abs(b.gx - a.gx);
    const ay = Math.abs(b.gy - a.gy);
    if (Math.min(ax, ay) <= Math.max(ax, ay) * 0.35) return [[a, b]];
    const elbow = ax >= ay ? { gx: b.gx, gy: a.gy } : { gx: a.gx, gy: b.gy };
    return [[a, elbow], [elbow, b]];
  }

  /** Bridges by zoom level (D-zoom): at map zoom only strong pairs
   * (15+ imports, pinned from the GestiKo distribution: 24 of 381
   * pairs, 41% of imports) draw, at both zooms. Weak pairs draw
   * nothing: as lines they read as brown lines that are not
   * bridges, and as decks they make a carpet (both owner calls).
   * Fallback with no texture: the old deck polygon / stroke. */
  private drawBridges(): void {
    const g = this.bridgeGfx;
    const proj = this.proj;
    g.clear();
    for (const child of this.bridgeSprites.removeChildren()) {
      // Mesh.destroy drops the geometry without destroying it; free
      // the GPU buffers explicitly (every zoom change redraws).
      if (child instanceof MeshSimple) child.geometry.destroy();
      child.destroy();
    }
    this.ropeGfx.clear();
    for (const child of this.postLayer.removeChildren()) child.destroy();
    this.postRanges = [];
    for (const pair of this.bridgePairs) {
      const strong = pair.count >= 15;
      if (this.zoomLevel === "map" && !strong) continue;
      const [ax, ay] = proj.project(pair.span[0].gx, pair.span[0].gy);
      const [bx, by] = proj.project(pair.span[1].gx, pair.span[1].gy);
      if (this.plankTexA || this.plankTexB) {
        if (!strong) continue;
        // Harbour rule: a deck draws only when its whole path is
        // open water (one water segment). A pair with an island
        // in between gets no deck at all. Clipped stubs read as
        // broken, duplicated bridges (owner call). Placement
        // (annealPlacement) works to make strong pairs
        // neighbours so this rule keeps most of them.
        if (!pair.clear) continue;
        // Ribbon deck: one mitered strip per leg (deckRibbon),
        // each leg in its direction plank texture (A up-right, B
        // down-right, same rule as the old tiles). Strips share
        // seam verts at elbows: bends of any angle render with
        // no gap and no overlap, plank phase continuous.
        const targetH = deckTargetH(pair.count);
        const pts = pair.points.map((p) => proj.project(p.gx, p.gy) as [number, number]);
        const texs: (Texture | null)[] = [];
        for (let i = 0; i + 1 < pts.length; i++) {
          let rot = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
          if (rot > Math.PI / 2) rot -= Math.PI;
          else if (rot < -Math.PI / 2) rot += Math.PI;
          texs.push((rot < 0 ? this.plankTexA : this.plankTexB) ?? this.plankTexA ?? this.plankTexB);
        }
        const periods = texs.map((t) => (t ? (t.width * targetH) / t.height : 1));
        const strips = deckRibbon(pts, targetH / 2, periods);
        for (let i = 0; i < strips.length; i++) {
          const tex = texs[i];
          if (!tex) continue;
          this.bridgeSprites.addChild(new MeshSimple({
            texture: tex,
            vertices: new Float32Array(strips[i].positions),
            uvs: new Float32Array(strips[i].uvs),
            indices: new Uint32Array(strips[i].indices),
          }));
        }
        this.drawRails(strips, targetH);
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

  /** Rail furniture for a ribbon deck: posts stamp along both
   * edges (rails stagger by half a spacing), one rope sags
   * between consecutive post tops. Edges come from the strip
   * verts, so rails follow miters and bevels exactly. */
  private drawRails(strips: RibbonStrip[], targetH: number): void {
    const post = this.postTex;
    if (!post) return;
    const start = this.postLayer.children.length;
    const { left: edgeL, right: edgeR } = deckEdges(strips);
    const postH = POST_H_FRAC * targetH;
    const scale = postH / post.height;
    for (const [edge, phase] of [[edgeL, 0], [edgeR, POST_SPACING / 2]] as const) {
      const studs = studsOnPath(edge, POST_SPACING, phase);
      for (const [x, y] of studs) {
        const spr = new Sprite(post);
        spr.anchor.set(0.5, 1);
        spr.scale.set(scale, scale);
        spr.position.set(x, y + 1);
        this.postLayer.addChild(spr);
      }
      const g = this.ropeGfx;
      studs.forEach(([x, y], k) => {
        const wy = y + 1 - ROPE_FRAC * postH;
        if (k === 0) g.moveTo(x, wy);
        else {
          const [px, py] = studs[k - 1];
          const pwy = py + 1 - ROPE_FRAC * postH;
          // Quadratic midpoint reaches half the control offset.
          g.quadraticCurveTo((px + x) / 2, (pwy + wy) / 2 + ROPE_SAG * 2, x, wy);
        }
      });
    }
    this.ropeGfx.stroke({ color: 0xc9a068, width: 2, alpha: 0.95 });
    this.postRanges.push({ start, count: this.postLayer.children.length - start });
  }

  /** Direction glow (owner: sprite frames, not code dots): one
   * glow sprite per import direction on a strong deck. The sprite
   * travels the span, importer toward imported, and cycles its
   * three frames (assets/sprites/glow-0..2.png) as it goes.
   * Island zoom only. This is a reading aid, not an agent signal
   * (DESIGN.md stillness rule: noted in the PR for judgement). */
  private drawPulses(nowMs: number): void {
    if (!this.glowLayer) return;
    this.glowLayer.visible = this.zoomLevel === "island" && this.glowTexs.length > 0;
    if (!this.glowLayer.visible) return;
    const frame = Math.floor(nowMs / 160) % 3;
    for (const glow of this.glowSprites) {
      const t = ((nowMs / 4500) + glow.phase) % 1;
      // Follow the deck path point by point (cum = path fractions).
      let i = 0;
      while (i < glow.cum.length - 2 && t > glow.cum[i + 1]) i++;
      const lt = (t - glow.cum[i]) / Math.max(1e-6, glow.cum[i + 1] - glow.cum[i]);
      const gx = glow.points[i].gx + (glow.points[i + 1].gx - glow.points[i].gx) * lt;
      const gy = glow.points[i].gy + (glow.points[i + 1].gy - glow.points[i].gy) * lt;
      const [px, py] = this.proj.project(gx, gy);
      glow.spr.position.set(px, py);
      // No glow over land: the path may cross an island in between.
      glow.spr.visible = !this.landCells.has(Math.floor(gx) + "," + Math.floor(gy));
      glow.spr.texture = this.glowTexs[(frame + Math.floor(glow.phase * 7)) % 3];
    }
  }

  /** Island whose land (its organic cells) holds the point, if
   * any. Water inside the bounding rect does not pick. */
  /** Screen px to fractional grid cells (inverse projection). */
  screenToGrid(sx: number, sy: number): { gx: number; gy: number } {
    const wx = (sx - this.cam.x) / this.cam.scale;
    const wy = (sy - this.cam.y) / this.cam.scale;
    // Invert the projection: project(0,0) is the origin, and one
    // grid step is (TW/2, TW/4) per axis.
    const [ox, oy] = this.proj.project(0, 0);
    const u = (wx - ox) / (this.proj.TW / 2);
    const v = (wy - oy) / (this.proj.TW / 4);
    return { gx: (u + v) / 2, gy: (v - u) / 2 };
  }

  islandAtScreen(sx: number, sy: number): string | null {
    const { gx, gy } = this.screenToGrid(sx, sy);
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    for (const isl of this.layout.islands) {
      if (isl.cells.has(cx + "," + cy)) return isl.id;
    }
    return null;
  }

  /** Screen position of an island's centre (drag tests aim here). */
  islandCenterScreen(id: string): [number, number] | null {
    const isl = this.layout.islands.find((i) => i.id === id);
    if (!isl) return null;
    const [wx, wy] = this.proj.project(isl.center.gx, isl.center.gy);
    return this.toScreen(wx, wy);
  }

  /** Pending drag-connect lanes (source = used island). */
  setLanes(lanes: { source: string; target: string }[]): void {
    this.lanes = lanes;
  }

  /** Lane state for drag tests (committed, confirming, preview). */
  laneDebug(): { lanes: number; confirming: boolean; preview: boolean } {
    return { lanes: this.lanes.length, confirming: this.confirmingLane !== null, preview: this.previewDrag !== null };
  }

  /** The lane under confirmation in the quest form, if any. */
  setConfirmingLane(lane: { source: string; target: string } | null): void {
    this.confirmingLane = lane;
  }

  /** Shore-to-shore centerline between two islands, in the same
   * span dialect as bridges (axis legs, bent fallback, shore
   * walk). Points run from the first island to the second, so
   * dashes march source -> target. Null when they touch. */
  private laneSpanPoints(fromId: string, toId: string): { gx: number; gy: number }[] | null {
    const a = this.layout.islands.find((i) => i.id === fromId);
    const b = this.layout.islands.find((i) => i.id === toId);
    if (!a || !b || a === b) return null;
    const rectA = { x: a.x, y: a.y, w: a.cols * PLOT, h: a.rows * PLOT };
    const rectB = { x: b.x, y: b.y, w: b.cols * PLOT, h: b.rows * PLOT };
    const axis = bridgeAxisLegs(rectA, rectB);
    let points: { gx: number; gy: number }[];
    if (axis) {
      points = [axis[0], axis[1]];
    } else {
      const bent = bridgeSpan(rectA, rectB);
      if (!bent) return null;
      const legs = this.spanLegs(bent);
      points = legs.length === 2 ? [legs[0][0], legs[0][1], legs[1][1]] : [bent[0], bent[1]];
    }
    const shoreEnd = (
      p: { gx: number; gy: number },
      other: { gx: number; gy: number },
      cells: Set<string>,
    ) => {
      const dx = p.gx - other.gx;
      const dy = p.gy - other.gy;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      for (let s = -2; s <= 3; s += 0.1) {
        const gx = p.gx + ux * s;
        const gy = p.gy + uy * s;
        if (cells.has(Math.floor(gx) + "," + Math.floor(gy))) {
          return { gx: gx - ux * 0.25, gy: gy - uy * 0.25 };
        }
      }
      return p;
    };
    const shore = [...points];
    shore[0] = shoreEnd(points[0], points[1], a.cells);
    shore[shore.length - 1] = shoreEnd(points[points.length - 1], points[points.length - 2], b.cells);
    return shore;
  }

  /** Lane gold (DESIGN.md), the only glow the product carries. */
  private drawLanes(nowMs: number): void {
    const g = this.laneGfx;
    if (!g) return;
    g.clear();
    const paths: { gx: number; gy: number }[][] = [];
    for (const lane of this.lanes) {
      const pts = this.laneSpanPoints(lane.source, lane.target);
      if (pts) paths.push(pts);
    }
    if (this.confirmingLane) {
      const pts = this.laneSpanPoints(this.confirmingLane.source, this.confirmingLane.target);
      if (pts) paths.push(pts);
    }
    if (this.previewDrag) {
      const from = this.layout.islands.find((i) => i.id === this.previewDrag!.from);
      if (from) {
        const cur = this.screenToGrid(this.previewDrag.sx, this.previewDrag.sy);
        paths.push([{ gx: from.center.gx, gy: from.center.gy }, { gx: cur.gx, gy: cur.gy }]);
      }
    }
    if (paths.length === 0) return;
    const isLand = (gx: number, gy: number) => this.landCells.has(Math.floor(gx) + "," + Math.floor(gy));
    const runs = paths.flatMap((pts) => waterSegments(pts, isLand));
    if (runs.length === 0) return;
    // Wide soft underlay first: the lane glows on the water.
    for (const [a, b] of runs) {
      const [ax, ay] = this.proj.project(a.gx, a.gy);
      const [bx, by] = this.proj.project(b.gx, b.gy);
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
    }
    g.stroke({ color: 0xffe3a3, width: 22, alpha: 0.35 });
    // Marching dashes over it: direction by animation, source to
    // target, never chevrons. Reduced motion freezes the march.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dash = 0.55;
    const gap = 0.4;
    const phase = still ? 0 : ((nowMs / 1000) * 1.6) % (dash + gap);
    for (const [a, b] of runs) {
      const segs = dashSegments([{ x: a.gx, y: a.gy }, { x: b.gx, y: b.gy }], dash, gap, phase);
      for (const [p, q] of segs) {
        const [ax, ay] = this.proj.project(p.x, p.y);
        const [bx, by] = this.proj.project(q.x, q.y);
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
      }
    }
    g.stroke({ color: 0xffe3a3, width: 7, alpha: 0.95 });
  }

  /** Screen position below an island's centre (report-card anchor). */
  islandScreenPos(id: string): [number, number] | null {
    const isl = this.layout.islands.find((i) => i.id === id);
    if (!isl) return null;
    const [wx, wy] = this.proj.project(isl.center.gx, isl.y + isl.rows * PLOT + 1.2);
    return this.toScreen(wx, wy);
  }

  /** Lane-gold selection ring around an island (D-create).
   * It pulses (UI feedback, owner: not evident enough) from the
   * ticker, so the picked island is unmissable. */
  selectIsland(id: string | null): void {
    this.ringIsland = id;
    this.drawRing(0);
  }

  private drawRing(nowMs: number): void {
    this.ring.clear();
    if (!this.ringIsland) return;
    const isl = this.layout.islands.find((i) => i.id === this.ringIsland);
    if (!isl) return;
    // Reduced motion: draw the ring steady, with no pulse.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(nowMs / 260);
    for (const [grow, width, alpha] of [[1.4, 3 + 1.6 * pulse, 0.65 + 0.35 * pulse], [2.3, 7, 0.12 + 0.1 * pulse]] as const) {
      const pts = [
        this.proj.project(isl.x - grow, isl.y - grow),
        this.proj.project(isl.x + isl.cols * PLOT + grow, isl.y - grow),
        this.proj.project(isl.x + isl.cols * PLOT + grow, isl.y + isl.rows * PLOT + grow),
        this.proj.project(isl.x - grow, isl.y + isl.rows * PLOT + grow),
      ];
      this.ring.poly(pts.flat());
      this.ring.stroke({ color: 0xffe3a3, width, alpha });
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
      el.setPointerCapture(e.pointerId);
      // A press on an island starts a lane drag, not a pan. Water
      // still pans; a tap still clicks (see pointerup).
      const rect = el.getBoundingClientRect();
      const hit = this.islandAtScreen(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        this.previewDrag = { from: hit, sx: e.clientX - rect.left, sy: e.clientY - rect.top };
      } else {
        drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y };
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (this.previewDrag) {
        const rect = el.getBoundingClientRect();
        this.previewDrag.sx = e.clientX - rect.left;
        this.previewDrag.sy = e.clientY - rect.top;
        return;
      }
      if (!drag) return;
      this.cam.x = drag.cx + (e.clientX - drag.x);
      this.cam.y = drag.cy + (e.clientY - drag.y);
      this.clampPan();
      this.applyCam();
    });
    el.addEventListener("pointerup", (e) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const preview = this.previewDrag;
      this.previewDrag = null;
      if (preview) {
        const to = this.islandAtScreen(sx, sy);
        // A tap on one island is a click, not a lane.
        if (to === preview.from && this.onCanvasClick) {
          this.onCanvasClick(sx, sy);
        } else if (to && to !== preview.from && this.onLaneDrop) {
          this.onLaneDrop(preview.from, to);
        }
        // Release on water, or without movement: cancel, no click.
        // (A lane press is deliberate: it never pans either.)
        return;
      }
      if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5 && this.onCanvasClick) {
        this.onCanvasClick(sx, sy);
      }
      drag = null;
    });
    el.addEventListener("pointercancel", () => {
      drag = null;
      this.previewDrag = null;
    });
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
    this.landCells = landSet;
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
        const rectA = { x: a.x, y: a.y, w: a.cols * PLOT, h: a.rows * PLOT };
        const rectB = { x: b.x, y: b.y, w: b.cols * PLOT, h: b.rows * PLOT };
        // Straight along one map axis when the rectangles overlap
        // on the other axis; the bent span is the fallback.
        const axis = bridgeAxisLegs(rectA, rectB);
        let span: [{ gx: number; gy: number }, { gx: number; gy: number }];
        let points: { gx: number; gy: number }[];
        if (axis) {
          span = axis;
          points = [axis[0], axis[1]];
        } else {
          const bent = bridgeSpan(rectA, rectB);
          if (!bent) continue;
          span = bent;
          const legs = this.spanLegs(bent);
          points = legs.length === 2 ? [legs[0][0], legs[0][1], legs[1][1]] : [bent[0], bent[1]];
        }
        // True shore points: walk each end toward its island
        // until it hits a real land cell, then step 0.25 cells
        // back into the water. Rectangle ends made decks float
        // in open water or run under the grass (owner calls).
        // Decks bury 0.3 cells past the shore; the glow keeps
        // the shore points, so it never runs on grass.
        const shoreEnd = (
          p: { gx: number; gy: number },
          other: { gx: number; gy: number },
          cells: Set<string>,
        ) => {
          const dx = p.gx - other.gx;
          const dy = p.gy - other.gy;
          const l = Math.hypot(dx, dy) || 1;
          const ux = dx / l;
          const uy = dy / l;
          for (let s = -2; s <= 3; s += 0.1) {
            const gx = p.gx + ux * s;
            const gy = p.gy + uy * s;
            if (cells.has(Math.floor(gx) + "," + Math.floor(gy))) {
              return { gx: gx - ux * 0.25, gy: gy - uy * 0.25 };
            }
          }
          return p;
        };
        const shorePoints = [...points];
        shorePoints[0] = shoreEnd(points[0], points[1], a.cells);
        shorePoints[shorePoints.length - 1] = shoreEnd(points[points.length - 1], points[points.length - 2], b.cells);
        const out = (p: { gx: number; gy: number }, q: { gx: number; gy: number }) => {
          const dx = p.gx - q.gx;
          const dy = p.gy - q.gy;
          const l = Math.hypot(dx, dy) || 1;
          return { gx: p.gx + (dx / l) * 0.3, gy: p.gy + (dy / l) * 0.3 };
        };
        const deckPoints = shorePoints.length === 2
          ? [out(shorePoints[0], shorePoints[1]), out(shorePoints[1], shorePoints[0])]
          : [out(shorePoints[0], shorePoints[1]), shorePoints[1], out(shorePoints[2], shorePoints[1])];
        this.bridgePairs.push({
          count: pair.count,
          span,
          deck: cityBridgeDeck(span, pair.count),
          points: deckPoints,
          // A bridge is a neighbour link (owner: we were stuck
          // patching symptoms). Deck path capped at 16 cells:
          // on GestiKo the true neighbour bridges are 2-13 cells;
          // the two map-crossing highways are 51 and 69.
          clear: deckPoints.reduce((n, pt, i) => (i ? n + Math.hypot(pt.gx - deckPoints[i - 1].gx, pt.gy - deckPoints[i - 1].gy) : 0), 0) <= 16
            && deckPoints.every((_, i) => i + 1 >= deckPoints.length
              || waterSegments([deckPoints[i], deckPoints[i + 1]], (gx, gy) => landSet.has(gx + "," + gy)).length === 1),
          dirs: pair.dirs.map((dir) => (dir.from === br.from ? shorePoints : [...shorePoints].reverse())),
        });
      }
    }
    this.plankTexA = (await Assets.load(plankAUrl).catch(() => null)) as Texture | null;
    this.plankTexB = (await Assets.load(plankBUrl).catch(() => null)) as Texture | null;
    this.postTex = (await Assets.load(postUrl).catch(() => null)) as Texture | null;
    // Ribbon uvs repeat along the deck: sampler wrap, not clamp.
    for (const t of [this.plankTexA, this.plankTexB]) {
      if (t) {
        t.source.style.addressModeU = "repeat";
        t.source.style.update();
      }
    }
    this.glowTexs = ((await Promise.all([glow0Url, glow1Url, glow2Url].map((u) => Assets.load(u).catch(() => null)))).filter(Boolean) as Texture[]);
    this.bridgeGfx = new Graphics();
    this.ropeGfx = new Graphics();
    // Decks below ropes below posts: ropes cross the deck but
    // tuck behind the post tops.
    root.addChild(this.bridgeSprites);
    root.addChild(this.ropeGfx);
    root.addChild(this.postLayer);
    root.addChild(this.bridgeGfx);
    this.drawBridges();
    // Lane layer above the bridges: pending connections read over
    // finished ones, on water only.
    this.laneGfx = new Graphics();
    root.addChild(this.laneGfx);

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

    // Glow sprites: one per import direction on strong decks.
    if (this.glowTexs.length) {
      let gi = 0;
      for (const pair of this.bridgePairs) {
        if (pair.count < 15) continue;
        if (!pair.clear) continue; // no deck, no glow (harbour rule)
        for (const points of pair.dirs) {
          gi++;
          const spr = new Sprite(this.glowTexs[0]);
          spr.anchor.set(0.5);
          spr.width = TW * 1.15;
          spr.height = TW * 0.67;
          spr.blendMode = "add";
          const cum = [0];
          for (let i = 0; i + 1 < points.length; i++) {
            const [px, py] = proj.project(points[i].gx, points[i].gy);
            const [qx, qy] = proj.project(points[i + 1].gx, points[i + 1].gy);
            cum.push(cum[i] + Math.hypot(qx - px, qy - py));
          }
          const total = cum[cum.length - 1] || 1;
          this.glowSprites.push({ spr, points, cum: cum.map((c) => c / total), phase: (gi * 0.37) % 1 });
          this.glowLayer.addChild(spr);
        }
      }
    }
    this.glowLayer.visible = false;
    root.addChild(this.glowLayer);

    // construction overlay on the building being edited
    const constructionTex = this.tex("construction");
    this.construction = new Sprite(constructionTex ?? Texture.EMPTY);
    this.construction.visible = false;
    this.construction.width = TW * 1.4;
    this.construction.height = TW * 1.4;
    root.addChild(this.construction);

    root.addChild(this.ring);
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
      this.drawLanes(time.lastTime);
      if (this.ringIsland) this.drawRing(time.lastTime);
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
      // Crashed keeps the scaffold frozen where the work died
      // (design: stalled-construction state); finished work clears it.
      this.construction.visible = view.state === "working" || view.state === "failed";
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
