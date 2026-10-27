import { describe, it, expect } from "vitest";
import { loadFailureText } from "./live";

// Regression: ISSUE-QA-001 — a refused repo path told the user to
// start a server that was already running.
// Found by /qa on 2026-10-27
// Report: .gstack/qa-reports/qa-report-localhost-2026-10-27.md
describe("load failure text", () => {
  it("a network failure says start the server", () => {
    const text = loadFailureText("http://127.0.0.1:8787", new TypeError("Failed to fetch"));
    expect(text).toContain("Could not reach the Repo City server");
    expect(text).toContain("cargo run");
  });

  it("a server refusal names the refusal, not a restart", () => {
    const text = loadFailureText(
      "http://127.0.0.1:8787",
      new Error("repo root is not a directory: /nope"),
    );
    expect(text).toContain("refused to open that repo");
    expect(text).toContain("repo root is not a directory: /nope");
    expect(text).not.toContain("cargo run");
  });
});
