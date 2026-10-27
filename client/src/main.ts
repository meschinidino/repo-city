import { buildWorld, renderGateFailures, type SheetPixels } from "./map/pipeline";
import { renderWorld } from "./map/renderPixi";
import type { PixelData } from "./map/pixels";
import { occlusion } from "./map/placement";
import { PASS } from "./map/checks";
import { layoutCity } from "./city/layoutCity";
import { CityView } from "./city/renderCity";
import { connectEvents, createSession, fetchExtraction, fetchReport, stopSession } from "./city/live";
import { applyEvent, initialView, type SessionView } from "./events/reduce";
import type { StoredEvent } from "./events/types";
import buildingsUrl from "../../assets/sprites/buildings.png";
import coastUrl from "../../assets/sprites/coast.png";
import shipUrl from "../../assets/sprites/ship.png";
import marketTreesUrl from "../../assets/sprites/market-flags-trees.png";

async function loadPixels(url: string): Promise<PixelData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}

async function loadWorld(status: HTMLElement) {
  const sheets: SheetPixels = {
    buildings: await loadPixels(buildingsUrl),
    coast: await loadPixels(coastUrl),
    ship: await loadPixels(shipUrl),
    marketTrees: await loadPixels(marketTreesUrl),
  };
  const world = buildWorld(sheets);
  // Fail-level geometry checks from DESIGN.md: a failing check stops the render, naming the check.
  const failures = renderGateFailures(world);
  if ((occlusion(world)[0]?.pct ?? 0) >= PASS.hiddenPct) failures.push("building hidden by others");
  if (failures.length) {
    status.textContent = `Sprite pipeline check failed: ${failures.join("; ")}. Map not rendered.`;
    status.classList.add("fail");
    (window as unknown as { __failures: string[] }).__failures = failures;
    return null;
  }
  return world;
}

async function mapMain(status: HTMLElement) {
  const world = await loadWorld(status);
  if (!world) return;
  const params = new URLSearchParams(location.search);
  const TW = params.get("full") ? 200 : Math.min(140, (innerWidth * Math.min(2, devicePixelRatio || 1)) / 21);
  const app = await renderWorld(world, TW);
  document.getElementById("app")!.appendChild(app.canvas);
  app.canvas.style.width = params.get("full") ? `${app.canvas.width}px` : "100%";
  if (!params.get("full")) app.canvas.style.height = "auto";
  const edge = Math.max(...world.tiles.map((t) => t.err));
  status.textContent = `Three-island test map · ${world.layout.placed.length} buildings · ${world.layout.trees.length} trees · tile edge error ${edge.toFixed(2)}% · all fail-level checks pass`;
  (window as unknown as { __world: unknown }).__world = world;
}

/** City mode (`?repo=<path>`): islands from the server's extraction
 * of a real repo, a live session, events over WebSocket. Motion
 * follows events only; the report comes from the real diff. */
async function cityMain(status: HTMLElement, params: URLSearchParams) {
  const repo = params.get("repo")!;
  const server = params.get("server") ?? "http://127.0.0.1:8787";
  const world = await loadWorld(status);
  if (!world) return;

  let extraction;
  try {
    extraction = await fetchExtraction(server, repo);
  } catch (e) {
    status.textContent = `Could not reach the Repo City server at ${server} (${(e as Error).message}). Start it with: cargo run --bin repo-city-server-bin (in server/). Nothing was rendered from invented data.`;
    status.classList.add("fail");
    return;
  }
  const layout = layoutCity(extraction);
  const city = new CityView(world, layout);
  const canvas = await city.init();
  document.getElementById("app")!.appendChild(canvas);
  (canvas as HTMLCanvasElement).style.width = "100%";
  (canvas as HTMLCanvasElement).style.height = "auto";

  const session = await createSession(server, repo, {
    task: params.get("task") ?? undefined,
    spawn: params.get("spawn") === "1",
  });
  const home = layout.islands[0]?.id ?? null;
  let view: SessionView = initialView(session.id, home);
  const exposed = { layout, view, session, report: null as unknown };
  (window as unknown as { __city: unknown }).__city = exposed;
  const refresh = () => {
    exposed.view = view;
    city.update(view);
    status.textContent =
      `Repo City · ${layout.islands.length} islands · ${layout.buildings.length} buildings · session ${view.state}` +
      (view.shipFile ? ` · ship at ${view.shipFile}` : view.locationUnknown ? " · location unknown" : "") +
      (view.cliSessionId ? ` · cli ${view.cliSessionId.slice(0, 8)}` : "");
  };
  refresh();

  const showReport = async () => {
    const report = await fetchReport(server, session.id);
    exposed.report = report;
    const el = document.getElementById("report")!;
    el.style.display = "block";
    el.textContent = report.available
      ? `Report (${report.generated_by})\n${report.summary}`
      : `Report unavailable (${report.generated_by})\n${report.reason ?? "no reason given"}\n${report.events?.length ?? 0} raw events recorded; no polished report was invented.`;
  };

  connectEvents(
    server,
    0,
    (event: StoredEvent) => {
      const before = view;
      view = applyEvent(view, event, layout.fileToIsland);
      if (view !== before) {
        refresh();
        if (event.type === "session_finished") void showReport().catch(() => undefined);
      }
    },
    () => undefined,
  );

  const controls = document.getElementById("controls")!;
  controls.style.display = "flex";
  document.getElementById("stop-report")!.addEventListener("click", async () => {
    await stopSession(server, session.id).catch(() => undefined);
    await showReport().catch(() => undefined);
    refresh();
  });
}

async function main() {
  const status = document.getElementById("status")!;
  const params = new URLSearchParams(location.search);
  if (params.get("repo")) await cityMain(status, params);
  else await mapMain(status);
}

main().catch((e) => {
  const status = document.getElementById("status")!;
  status.textContent = `Couldn't build the scene: ${e?.message ?? e}`;
  status.classList.add("fail");
  console.error(e);
});
