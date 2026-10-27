import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchExtraction, loadFailureText, LiveError } from "./live";

// Regression: ISSUE-QA-001 — a refused repo path told the user to
// start a server that was already running; and review follow-ups:
// 5xx without an error body, non-JSON answers, and malformed server
// URLs each need their own instruction.
// Found by /qa on 2026-10-27
// Report: .gstack/qa-reports/qa-report-localhost-2026-10-27.md

const SERVER = "http://127.0.0.1:8787";

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

async function failureOf(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected failure");
    },
    (e: unknown) => e as Error,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("load failure classification (stubbed fetch)", () => {
  it("network down → start the server", async () => {
    // A CORS refusal is the same TypeError at the fetch layer, so
    // the copy names both options instead of assuming one cause.
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const e = await failureOf(fetchExtraction(SERVER, "/repo"));
    expect(e).toBeInstanceOf(LiveError);
    const text = loadFailureText(SERVER, e);
    expect(text).toContain("cargo run");
    expect(text).toContain("refusing this page's origin");
  });

  it("400 with an error body → refused, fix the path", async () => {
    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "repo root is not a directory: /nope" }), { status: 400 })),
    );
    const e = await failureOf(fetchExtraction(SERVER, "/nope"));
    const text = loadFailureText(SERVER, e);
    expect(text).toContain("refused to open that repo");
    expect(text).not.toContain("cargo run");
  });

  it("500 without an error body → server errored, check its output", async () => {
    stubFetch(() => Promise.resolve(new Response("boom", { status: 500 })));
    const e = await failureOf(fetchExtraction(SERVER, "/repo"));
    expect(loadFailureText(SERVER, e)).toContain("server errored");
  });

  it("200 with HTML (wrong server) → not Repo City JSON", async () => {
    stubFetch(() => Promise.resolve(new Response("<html>vite</html>", { status: 200 })));
    const e = await failureOf(fetchExtraction(SERVER, "/repo"));
    expect(loadFailureText(SERVER, e)).toContain("not with Repo City JSON");
  });

  it("malformed server URL → fix the address", async () => {
    const e = await failureOf(fetchExtraction("not a url", "/repo"));
    expect(loadFailureText("not a url", e)).toContain("not a valid URL");
  });

  it("scheme-less host:port (localhost:8787) → fix the address, not restart", async () => {
    const e = await failureOf(fetchExtraction("localhost:8787", "/repo"));
    expect(loadFailureText("localhost:8787", e)).toContain("must start with http://");
  });
});
