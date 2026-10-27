import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { World } from "../map/pipeline";
import { PLAIN_GRASS_INDEX } from "../map/coast";
import { pixelsToCanvas } from "../map/renderPixi";
import { TWBASE } from "../map/tileFit";
import { cityProjector, PLOT, type CityLayout } from "./layoutCity";
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

  /** Screen position of a file's plot centre (for tests and labels). */
  fileScreenPos(file: string): [number, number] | null {
    const pos = this.layout.filePos.get(file);
    if (!pos) return null;
    return this.proj.project(pos.gx + PLOT / 2, pos.gy + PLOT / 2);
  }

  shipScreenPos(): [number, number] {
    return [this.ship.position.x, this.ship.position.y];
  }

  get shipVisible(): boolean {
    return this.ship.visible;
  }

  async init(): Promise<HTMLElement> {
    const { TW } = { TW: 64 };
    const proj = this.proj;
    await this.app.init({ width: proj.width, height: proj.height, background: 0x4f98a6, antialias: true, resolution: 1 });
    const root = new Container();
    this.app.stage.addChild(root);
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

    // bridges between island centres, width grows with import count
    const byId = new Map(this.layout.islands.map((i) => [i.id, i]));
    const bridges = new Graphics();
    for (const br of this.layout.bridges) {
      const a = byId.get(br.from);
      const b = byId.get(br.to);
      if (!a || !b) continue;
      const [ax, ay] = proj.project(a.center.gx, a.center.gy);
      const [bx, by] = proj.project(b.center.gx, b.center.gy);
      bridges.moveTo(ax, ay);
      bridges.lineTo(bx, by);
      bridges.stroke({ color: 0xb98652, alpha: 0.8, width: Math.min(10, 2 + Math.log2(br.count + 1)) });
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
      items.push({ depth: b.gx + b.gy + 0.6, kind: 1, node: c });
    }

    items.sort((a, b) => a.depth - b.depth || a.kind - b.kind).forEach((it) => root.addChild(it.node));

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
      this.glow.fill({ color: 0xffd34d, alpha: 0.4 });
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
      this.glow.fill({ color: view.testPassed ? 0x3fae5a : 0xd4402b, alpha: 0.95 });
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
