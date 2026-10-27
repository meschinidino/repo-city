/** Pass levels from DESIGN.md "Sprite pipeline > Checks". The client fails (does not render) when a fail-level check fails. */
export const PASS = {
  plateShapePct: 8,
  baseOutsidePct: 3,
  tileEdgePct: 1,
  tileGapPct: 0.5,
  hiddenPct: 10,
} as const;

export interface CheckResult { name: string; status: "pass" | "warn" | "fail" | "info"; value: string; how: string }
export const isFail = (c: CheckResult) => c.status === "fail";
