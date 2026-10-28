import { buildWorld, renderGateFailures, type SheetPixels } from "./map/pipeline";
import { renderWorld } from "./map/renderPixi";
import type { PixelData } from "./map/pixels";
import { occlusion } from "./map/placement";
import { PASS } from "./map/checks";
import { layoutCity } from "./city/layoutCity";
import { CityView } from "./city/renderCity";
import { connectEvents, createSession, fetchExtraction, fetchReport, loadFailureText, stopSession, type SessionInfo } from "./city/live";
import { applyEvent, initialView, type SessionView } from "./events/reduce";
import { HarborBar } from "./city/bar";
import type { SessionInfo as BarSession } from "./city/live";
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
  document.getElementById("new-quest")!.style.display = "none";
  const opener = document.getElementById("repo-opener")! as HTMLFormElement;
  opener.style.display = "flex";
  opener.addEventListener("submit", (e) => {
    e.preventDefault();
    const path = (document.getElementById("repo-path") as HTMLInputElement).value.trim();
    if (path) location.search = `?repo=${encodeURIComponent(path)}`;
  });
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
    status.textContent = loadFailureText(server, e as Error);
    status.classList.add("fail");
    return;
  }
  const layout = layoutCity(extraction);
  const city = new CityView(world, layout);
  const canvas = await city.init();
  document.getElementById("app")!.appendChild(canvas);
  (canvas as HTMLCanvasElement).style.width = "100vw";
  (canvas as HTMLCanvasElement).style.height = "100vh";
  (canvas as HTMLCanvasElement).style.display = "block";

  let session: SessionInfo;
  try {
    session = await createSession(server, repo, {
      task: params.get("task") ?? undefined,
      spawn: params.get("spawn") === "1",
    });
  } catch (e) {
    status.textContent = loadFailureText(server, e as Error, "create a session");
    status.classList.add("fail");
    return;
  }
  // Harbor bar (T12): tokens for every session of this repo, the
  // quest log, and the report card. The event flow below still
  // follows this primary session.
  const bar = new HarborBar({
    server,
    repo,
    islands: layout.islands.map((i) => ({ id: i.id, name: i.name })),
    onShowReport: (s) => void showReport(s),
    onTargetPicked: (id) => city.selectIsland(id),
    onSessionsChanged: () => {},
  });
  city.onCanvasClick = (sx, sy) => {
    const id = city.islandAtScreen(sx, sy);
    if (id) {
      city.selectIsland(id);
      bar.setTargetIsland(id);
    }
  };
  void bar.refresh();
  // The quest log sits directly above the bar. The bar height
  // changes when its rows wrap (narrow windows), so measure it
  // instead of a fixed offset (QA: create button overlapped the
  // bar buttons at 360px wide).
  const placeQuestlog = () => {
    const barEl = document.getElementById("bar")!;
    const logEl = document.getElementById("questlog")!;
    logEl.style.bottom = `${barEl.offsetHeight + 8}px`;
    // Cap the height against the same measured bar, so a tall
    // (wrapped) bar cannot push the sheet top off-screen.
    logEl.style.maxHeight = `calc(100dvh - ${barEl.offsetHeight + 24}px)`;
  };
  placeQuestlog();
  window.addEventListener("resize", placeQuestlog);
  // The bar can also grow later (status text wraps, tokens are
  // added), so watch its size, not only window resizes.
  new ResizeObserver(placeQuestlog).observe(document.getElementById("bar")!);
  // Tokens follow every session, not only the primary one: poll
  // the list, and re-anchor an open report card as the camera moves.
  setInterval(() => void bar.refresh(), 5000);
  setInterval(() => {
    const el = document.getElementById("report")!;
    if (el.style.display === "block") placeReportCard(reportIsland);
  }, 750);
  window.addEventListener("resize", () => {
    const el = document.getElementById("report")!;
    if (el.style.display === "block") placeReportCard(reportIsland);
  });

  // No island is chosen at creation (quest targeting is T12), so the
  // ship has no home: it stays off-screen until a real event places
  // it. Drawing it at the biggest island would invent a location.
  let view: SessionView = initialView(session.id, session.island_id);
  const exposed = { layout, view, session, report: null as unknown, city };
  (window as unknown as { __city: unknown }).__city = exposed;
  const droppedNote =
    layout.droppedFiles.length > 0 ? ` · ${layout.droppedFiles.length} files without an island (not drawn)` : "";
  const refresh = (extra = "") => {
    exposed.view = view;
    city.update(view);
    status.textContent =
      `Repo City · ${layout.islands.length} islands · ${layout.buildings.length} buildings · session ${view.state}` +
      (view.shipFile ? ` · ship at ${view.shipFile}` : view.locationUnknown ? " · location unknown" : "") +
      (view.cliSessionId ? ` · cli ${view.cliSessionId.slice(0, 8)}` : "") +
      droppedNote +
      extra;
  };
  refresh();

  // Report card beside its island (D-report-place), clamped to
  // the viewport, with a leader line to the island. Without an
  // island it docks to the right edge. Step 4 shows the report
  // plus one honest line; actions arrive in step 5 (D-card-actions).
  const placeReportCard = (islandId: string | null) => {
    const el = document.getElementById("report")!;
    const line = document.getElementById("report-line")!;
    el.style.display = "block";
    const w = Math.min(380, window.innerWidth - 24);
    const anchor = islandId ? city.islandScreenPos(islandId) : null;
    if (!anchor) {
      el.style.left = `${Math.max(8, window.innerWidth - w - 12)}px`;
      el.style.top = "12px";
      line.style.display = "none";
      const close0 = document.getElementById("report-close")!;
      close0.style.display = "block";
      close0.style.left = `${Math.max(8, window.innerWidth - w - 12) + w - 76}px`;
      close0.style.top = "20px";
      return;
    }
    const left = Math.min(Math.max(8, anchor[0] - w / 2), Math.max(8, window.innerWidth - w - 8));
    // Above the island when below would bury the card in the bar.
    // Measure both: the bar grows when it wraps (narrow windows),
    // and the card height depends on its content.
    const barH = document.getElementById("bar")!.offsetHeight;
    const h = el.offsetHeight;
    let top = anchor[1] + 16;
    let below = true;
    if (top + h > window.innerHeight - barH - 8) {
      top = anchor[1] - h - 16;
      below = false;
    }
    top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - barH - 8 - h)));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const cx = left + w / 2;
    const dx = cx - anchor[0];
    const dy = (below ? top + h : top) - anchor[1];
    line.style.display = "block";
    line.style.left = `${anchor[0]}px`;
    line.style.top = `${anchor[1]}px`;
    line.style.width = `${Math.hypot(dx, dy)}px`;
    line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    const close = document.getElementById("report-close")!;
    close.style.display = "block";
    close.style.left = `${left + w - 76}px`;
    close.style.top = `${top + 8}px`;
  };
  document.getElementById("report-close")!.addEventListener("click", () => {
    document.getElementById("report")!.style.display = "none";
    document.getElementById("report-line")!.style.display = "none";
    document.getElementById("report-close")!.style.display = "none";
  });

  let reportSeq = 0;
  let reportIsland: string | null = null;
  const showReport = async (forSession: BarSession = session) => {
    const seq = ++reportSeq;
    reportIsland = forSession.island_id;
    const el = document.getElementById("report")!;
    el.textContent = "Loading the report…";
    placeReportCard(reportIsland);
    try {
      const report = await fetchReport(server, forSession.id);
      if (seq !== reportSeq) return; // a newer report owns the card
      if (forSession.id === session.id) exposed.report = report;
      el.textContent = (report.available
        ? `Report (${report.generated_by})\n${report.summary}`
        : `Report unavailable (${report.generated_by})\n${report.reason ?? "no reason given"}\n${report.events?.length ?? 0} raw events recorded; no polished report was invented.`)
        + "\n\nFinish flow arrives in step 5.";
    } catch (e) {
      if (seq !== reportSeq) return;
      el.textContent = `Report unavailable\nCould not fetch the report: ${(e as Error).message}. The raw events are in the server log; no report was invented.`;
      status.classList.add("fail");
      refresh(" · report fetch failed");
    }
  };

  // Reconnecting stream: resume after the last event id seen; the
  // reducer ignores replayed duplicates by sequence.
  let lastEventId = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    connectEvents(
      server,
      lastEventId,
      (event: StoredEvent) => {
        lastEventId = Math.max(lastEventId, event.id);
        const before = view;
        view = applyEvent(view, event, layout.fileToIsland);
        if (view !== before) {
          refresh();
          if (event.type === "session_finished") { void showReport(); void bar.refresh(); }
        }
      },
      (state) => {
        if (state === "open") {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
          status.classList.remove("fail");
          refresh();
        } else if (!reconnectTimer) {
          // error and close both fire for one dead socket: schedule
          // exactly one reconnect, never a doubling tree of them.
          status.classList.add("fail");
          refresh(" · connection lost — reconnecting, picture may be stale");
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, 1000);
        }
      },
    );
  };
  connect();

  const controls = document.getElementById("controls")!;
  controls.style.display = "flex";
  document.getElementById("stop-report")!.addEventListener("click", async () => {
    try {
      await stopSession(server, session.id);
    } catch (e) {
      status.classList.add("fail");
      refresh(` · stop failed: ${(e as Error).message} (this click stopped nothing)`);
      return;
    }
    await showReport();
    void bar.refresh();
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
