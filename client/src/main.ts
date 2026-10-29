import { buildWorld, renderGateFailures, type SheetPixels } from "./map/pipeline";
import { renderWorld } from "./map/renderPixi";
import type { PixelData } from "./map/pixels";
import { occlusion } from "./map/placement";
import { PASS } from "./map/checks";
import { layoutCity } from "./city/layoutCity";
import { CityView } from "./city/renderCity";
import { acceptSession, connectEvents, createSession, fetchAcceptPreview, fetchExtraction, fetchReport, fetchSessionEvents, loadFailureText, sessionAction, stopSession, type AcceptPreview, type DiffReportView, type SessionInfo } from "./city/live";
import { applyEvent, initialView, type SessionView } from "./events/reduce";
import { HarborBar, stateText } from "./city/bar";
import { cleanupWarningLine, escHtml, isFinishable, lastFinishNote, lastTestResult, stallText, testLine } from "./city/finish";
import { dragTaskText, hasEdge, validateDrop } from "./city/lane";
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
  let knownSessions: BarSession[] = [];
  const islandName = (id: string) => layout.islands.find((i) => i.id === id)?.name ?? id;
  // One-shot refusal note above the bar (drag-connect rejections).
  // A showing toast resets its timer instead of stacking.
  let toastTimer = 0;
  const toast = (text: string) => {
    const el = document.getElementById("toast")!;
    el.textContent = text;
    el.style.display = "block";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (el.style.display = "none"), 4000);
  };
  // Pending lanes: drag quests still open whose import does not
  // exist yet. Terminal quests drop out; a lane becomes a bridge
  // only once the extraction carries the real import.
  const reconcileLanes = () => {
    const terminal = new Set(["accepted", "discarded", "archived"]);
    city.setLanes(
      knownSessions
        .filter(
          (s) =>
            s.source_island_id &&
            s.island_id &&
            !terminal.has(s.state) &&
            !hasEdge(layout.bridges, s.island_id, s.source_island_id),
        )
        .map((s) => ({ source: s.source_island_id!, target: s.island_id! })),
    );
  };
  const bar = new HarborBar({
    server,
    repo,
    islands: layout.islands.map((i) => ({ id: i.id, name: i.name })),
    onShowReport: (s) => void showReport(s),
    onTargetPicked: (id) => {
      city.selectIsland(id);
      // Retargeting a drag confirmation redraws its lane; the
      // create path re-validates, so an invalid pick refuses
      // there with its reason instead of here.
      if (bar.pendingDragSource) {
        city.setConfirmingLane(id ? { source: bar.pendingDragSource, target: id } : null);
      }
    },
    onSessionsChanged: (ss) => {
      knownSessions = ss;
      reconcileLanes();
      refresh();
    },
    onFollow: (s) => void follow(s),
    onDragChange: (lane) => city.setConfirmingLane(lane),
  });
  bar.dragEdges = layout.bridges;
  city.onCanvasClick = (sx, sy) => {
    const id = city.islandAtScreen(sx, sy);
    if (id) {
      city.selectIsland(id);
      bar.setTargetIsland(id);
    } else {
      // Open water: the quest closes (owner call).
      city.selectIsland(null);
      bar.closeQuest();
    }
  };
  // Drag-connect (step 6): a lane drop validates, then opens the
  // quest form as the editable confirmation card. Nothing runs
  // before the user confirms there.
  city.onLaneDrop = (fromId, toId) => {
    const check = validateDrop(fromId, toId, layout.bridges, knownSessions, islandName);
    if (!check.ok) {
      toast(check.reason);
      return;
    }
    bar.beginDragConfirm(fromId, toId, dragTaskText(islandName(fromId), islandName(toId)));
  };
  // Escape cancels a drag confirmation like closing the log.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bar.pendingDragSource) bar.closeQuest();
  });
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
    logEl.style.maxHeight = `min(calc(100dvh - ${barEl.offsetHeight + 16}px), 82dvh)`;
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
  // The quest the map follows: the primary session until the
  // user picks another in the bar. Stop & report acts on this
  // quest, never silently on the primary (Codex review).
  let followed: BarSession = session;
  let followGen = 0;
  let replayBuffer: { id: string; events: StoredEvent[] } | null = null;
  const follow = async (target: BarSession | null) => {
    const quest = target ?? session;
    followed = quest;
    const gen = ++followGen;
    view = initialView(quest.id, quest.island_id);
    exposed.view = view;
    refresh();
    // Live events for this quest buffer while its log replays,
    // then merge in seq order (the reducer drops duplicates),
    // so no early history is lost to a fast live event.
    replayBuffer = { id: quest.id, events: [] };
    try {
      const events = await fetchSessionEvents(server, quest.id);
      if (gen !== followGen) return; // a newer pick owns the map
      for (const event of events) view = applyEvent(view, event, layout.fileToIsland);
    } catch {
      // No replay available: live events still land on the
      // followed quest; nothing is invented meanwhile.
    }
    if (gen !== followGen) return;
    const buffered = replayBuffer?.id === quest.id ? replayBuffer.events : [];
    replayBuffer = null;
    for (const event of buffered.sort((a, b) => a.seq - b.seq)) {
      view = applyEvent(view, event, layout.fileToIsland);
    }
    refresh();
  };
  const exposed = { layout, view, session, report: null as unknown, city };
  (window as unknown as { __city: unknown }).__city = exposed;
  const droppedNote =
    layout.droppedFiles.length > 0 ? ` · ${layout.droppedFiles.length} files without an island (not drawn)` : "";
  const refresh = (extra = "") => {
    exposed.view = view;
    city.update(view);
    const known = knownSessions.find((x) => x.id === followed.id) ?? followed;
    const stall = stallText(known, Date.now());
    status.textContent =
      `Repo City · ${layout.islands.length} islands · ${layout.buildings.length} buildings · session ${view.state}` +
      (view.shipFile ? ` · ship at ${view.shipFile}` : view.locationUnknown ? " · location unknown" : "") +
      (view.cliSessionId ? ` · cli ${view.cliSessionId.slice(0, 8)}` : "") +
      (stall ? ` · stalled — ${stall}` : "") +
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

  /** Session branch name (server branch_for): display only. */
  const branchFor = (id: string) => `repo-city/${id.slice(0, 8)}`;

  const reportText = (report: DiffReportView): string =>
    report.available
      ? `Report (${report.generated_by})\n${report.summary}`
      : `Report unavailable (${report.generated_by})\n${report.reason ?? "no reason given"}\n${report.events?.length ?? 0} raw events recorded; no polished report was invented.`;

  /** Finish section states: preview, one confirmation per
   * destructive choice, result. Every view ends on Back, which
   * reloads the card from the server. */
  const renderFinish = (box: HTMLElement, forSession: BarSession, preview: AcceptPreview, events: StoredEvent[]) => {
    const s = preview.session;
    const note = lastFinishNote(events);
    if (s.state === "accepted" || s.state === "discarded") {
      box.innerHTML =
        `<h3>Finish</h3><div class="report-line">${escHtml(note ?? `This quest was ${s.state}.`)}</div>` +
        `<div class="report-line report-muted">Archive it from the quest log when done reading.</div>`;
      return;
    }
    if (!isFinishable(s.state)) {
      box.innerHTML =
        `<h3>Finish</h3><div class="report-line report-muted">Finish opens when the quest stops (now: ${escHtml(stateText(s.state))}).</div>`;
      return;
    }
    const lines = [
      `Merge into: ${preview.base_branch ?? "unknown — this quest started before the finish flow"}`,
      preview.current_branch
        ? `Main checkout: ${preview.current_branch}${preview.on_target ? " (on target)" : preview.base_branch ? ` (switch to ${preview.base_branch} to accept)` : ""}`
        : "Main checkout: unreadable",
      preview.dirty_files.length ? `Uncommitted in main: ${preview.dirty_files.join(", ")}` : "Main checkout: clean",
      ...(preview.merge_in_progress ? ["Main checkout: an unfinished merge waits — finish or abort it first"] : []),
      ...(!preview.worktree_exists ? ["Quest worktree: gone — nothing left to merge"] : []),
      preview.test ? `Checks: ${preview.test.command} (from ${preview.test.source})` : "Checks: not run — no test command found",
    ];
    box.innerHTML =
      "<h3>Finish</h3>" +
      lines.map((l) => `<div class="report-line">${escHtml(l)}</div>`).join("") +
      `<div class="action-row"><button class="primary-btn" type="button" data-act="accept">Accept</button>` +
      `<button class="ghost-btn" type="button" data-act="keep">Keep for later</button>` +
      `<button class="ghost-btn" type="button" data-act="discard">Discard</button></div>`;
    box.querySelector('[data-act="accept"]')!.addEventListener("click", () => confirmAccept(box, forSession, preview));
    box.querySelector('[data-act="keep"]')!.addEventListener("click", () => void doKeep(box, forSession, preview));
    box.querySelector('[data-act="discard"]')!.addEventListener("click", () => confirmDiscard(box, forSession, preview));
  };

  const backRow = `<div class="action-row"><button class="ghost-btn" type="button" data-act="back">Back to report</button></div>`;
  const wireBack = (box: HTMLElement, forSession: BarSession) => {
    box.querySelector('[data-act="back"]')!.addEventListener("click", () => void showReport(forSession));
  };
  const busy = (box: HTMLElement, text: string) => {
    box.querySelectorAll("button").forEach((b) => {
      (b as HTMLButtonElement).disabled = true;
    });
    const d = document.createElement("div");
    d.className = "report-line report-muted";
    d.dataset.role = "busy";
    d.textContent = text;
    box.appendChild(d);
  };
  /** Drop the busy note and unlock the buttons after a refusal. */
  const unbusy = (box: HTMLElement) => {
    box.querySelector('[data-role="busy"]')?.remove();
    box.querySelectorAll("button").forEach((b) => {
      (b as HTMLButtonElement).disabled = false;
    });
  };

  const confirmAccept = (box: HTMLElement, forSession: BarSession, preview: AcceptPreview) => {
    const s = preview.session;
    const checks = preview.test ? `${preview.test.command} (from ${preview.test.source})` : "not run — no test command found";
    box.innerHTML =
      "<h3>Accept this quest?</h3>" +
      `<div class="report-line">Merge branch ${escHtml(branchFor(s.id))} into ${escHtml(preview.base_branch ?? "unknown")}.</div>` +
      `<div class="report-line">Uncommitted quest work is committed on the quest branch first.</div>` +
      `<div class="report-line">Then checks run in your main checkout: ${escHtml(checks)}.</div>` +
      `<div class="report-line report-muted">This changes your main checkout. A conflict or failing checks stops the merge.</div>` +
      `<div class="action-row"><button class="primary-btn" type="button" data-act="go">Merge and run checks</button>` +
      `<button class="ghost-btn" type="button" data-act="back">Back</button></div>` +
      `<div class="report-err" data-role="err" style="display:none"></div>`;
    wireBack(box, forSession);
    box.querySelector('[data-act="go"]')!.addEventListener("click", () => void doAccept(box, forSession, s.id));
  };

  const doAccept = async (box: HTMLElement, forSession: BarSession, id: string) => {
    busy(box, "Merging… checks can take minutes.");
    try {
      const r = await acceptSession(server, id);
      const checks = r.test_command ? `Checks passed (${r.test_command}).` : "Checks not run (no test command found).";
      const warning = cleanupWarningLine(r.cleanup_warning);
      box.innerHTML =
        "<h3>Accepted</h3>" +
        `<div class="report-ok">${escHtml(`Merged into ${r.session.base_branch ?? "the main checkout"} (${r.merge_sha.slice(0, 8)}).`)}</div>` +
        `<div class="report-line">${escHtml(checks)}</div>` +
        (warning ? `<div class="report-err">${escHtml(warning)}</div>` : "") +
        (r.test_output ? `<pre class="report-pre">${escHtml(r.test_output)}</pre>` : "") +
        backRow;
      wireBack(box, forSession);
      void bar.refresh();
      refresh();
    } catch (e) {
      const message = (e as Error).message;
      const err = box.querySelector('[data-role="err"]')!;
      err.textContent = message;
      (err as HTMLElement).style.display = "block";
      unbusy(box);
      // The conflict path (design): the card keys off the
      // server's conflict wording; any other refusal shows as
      // text with a way back. If the wording ever changes, the
      // error still shows — only the inline send-back hides.
      if (message.includes("conflicts on")) {
        const row = document.createElement("div");
        row.innerHTML =
          `<div class="report-line">Send the quest back to fix it, or discard:</div>` +
          `<input type="text" data-role="fix" placeholder="What should the agent fix?" />` +
          `<div class="action-row"><button class="primary-btn" type="button" data-act="sendback">Send back to fix</button></div>`;
        box.appendChild(row);
        row.querySelector('[data-act="sendback"]')!.addEventListener("click", () => void doSendBack(box, forSession, id));
      }
      placeReportCard(reportIsland);
    }
  };

  const doSendBack = async (box: HTMLElement, forSession: BarSession, id: string) => {
    const input = box.querySelector('[data-role="fix"]') as HTMLInputElement | null;
    const err = box.querySelector('[data-role="err"]') as HTMLElement | null;
    const task = input?.value.trim() ?? "";
    if (!task) {
      if (err) {
        err.textContent = "Write what the agent should fix first.";
        err.style.display = "block";
      }
      return;
    }
    busy(box, "Sending back…");
    try {
      await sessionAction(server, id, "follow-up", task);
      box.innerHTML =
        "<h3>Sent back</h3>" +
        `<div class="report-line">The quest runs again with new instructions.</div>` +
        backRow;
      wireBack(box, forSession);
      void bar.refresh();
      refresh();
    } catch (e) {
      if (err) {
        err.textContent = (e as Error).message;
        err.style.display = "block";
      }
      unbusy(box);
    }
  };

  const confirmDiscard = (box: HTMLElement, forSession: BarSession, preview: AcceptPreview) => {
    box.innerHTML =
      "<h3>Discard this quest?</h3>" +
      `<div class="report-line">Remove the worktree and branch ${escHtml(branchFor(preview.session.id))}.</div>` +
      `<div class="report-line">Unmerged work is deleted. This cannot be undone.</div>` +
      `<div class="action-row"><button class="primary-btn" type="button" data-act="go">Discard the work</button>` +
      `<button class="ghost-btn" type="button" data-act="back">Back</button></div>` +
      `<div class="report-err" data-role="err" style="display:none"></div>`;
    wireBack(box, forSession);
    box.querySelector('[data-act="go"]')!.addEventListener("click", () => void doDiscard(box, forSession, preview.session.id));
  };

  const doDiscard = async (box: HTMLElement, forSession: BarSession, id: string) => {
    busy(box, "Discarding…");
    try {
      await sessionAction(server, id, "discard");
      box.innerHTML = "<h3>Discarded</h3>" + `<div class="report-line">Quest discarded: the worktree and session branch were removed.</div>` + backRow;
      wireBack(box, forSession);
      void bar.refresh();
      refresh();
    } catch (e) {
      box.innerHTML = `<h3>Discard</h3><div class="report-err">${escHtml((e as Error).message)}</div>` + backRow;
      wireBack(box, forSession);
    }
  };

  const doKeep = async (box: HTMLElement, forSession: BarSession, preview: AcceptPreview) => {
    busy(box, "Keeping…");
    try {
      await sessionAction(server, preview.session.id, "keep");
      box.innerHTML =
        "<h3>Kept for later</h3>" + `<div class="report-line">Quest kept for later: the worktree stays untouched.</div>` + backRow;
      wireBack(box, forSession);
      void bar.refresh();
      refresh();
    } catch (e) {
      box.innerHTML = `<h3>Keep for later</h3><div class="report-err">${escHtml((e as Error).message)}</div>` + backRow;
      wireBack(box, forSession);
    }
  };

  const renderReportCard = (el: HTMLElement, forSession: BarSession, report: DiffReportView, preview: AcceptPreview, events: StoredEvent[]) => {
    const tr = lastTestResult(events);
    el.innerHTML =
      `<div>${escHtml(reportText(report))}</div>` +
      (tr ? `<div class="report-test ${tr.passed ? "report-test-pass" : "report-test-fail"}">${escHtml(testLine(tr))}</div>` : "") +
      `<div class="report-finish"></div>`;
    renderFinish(el.querySelector(".report-finish")!, forSession, preview, events);
  };

  const showReport = async (forSession: BarSession = session) => {
    const seq = ++reportSeq;
    reportIsland = forSession.island_id;
    const el = document.getElementById("report")!;
    el.textContent = "Loading the report…";
    placeReportCard(reportIsland);
    try {
      const [report, preview, events] = await Promise.all([
        fetchReport(server, forSession.id),
        fetchAcceptPreview(server, forSession.id),
        fetchSessionEvents(server, forSession.id),
      ]);
      if (seq !== reportSeq) return; // a newer report owns the card
      if (forSession.id === session.id) exposed.report = report;
      renderReportCard(el, forSession, report, preview, events);
      placeReportCard(reportIsland);
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
        if (replayBuffer && event.session_id === replayBuffer.id) {
          replayBuffer.events.push(event);
          return;
        }
        const before = view;
        view = applyEvent(view, event, layout.fileToIsland);
        if (view !== before) {
          refresh();
          if (event.type === "session_finished" && event.session_id === session.id) { void showReport(); void bar.refresh(); }
          else if (event.type === "session_finished") { void bar.refresh(); }
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
      await stopSession(server, followed.id);
    } catch (e) {
      status.classList.add("fail");
      refresh(` · stop failed: ${(e as Error).message} (this click stopped nothing)`);
      return;
    }
    await showReport(followed);
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
