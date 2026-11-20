import { expect, test } from "bun:test";
import type { PlanUsage } from "@agenteschat/adapters";
import { overCap, rankByWeeklyReset, Reservations, weeklyState } from "../src/weekly-quota";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const h = (n: number) => new Date(NOW + n * 3600_000).toISOString();
const usage = (used: number, resetIn: number, seenAgo = 0): PlanUsage => ({
  windows: [{ kind: "seven_day", usedPercent: used, resetsAt: h(resetIn) }],
  source: "turn",
  at: h(-seenAgo),
});
const none = { capPercent: null, releaseHours: null };
const cap70 = { capPercent: 70, releaseHours: 24 };

test("nearest weekly reset comes first", () => {
  const r = rankByWeeklyReset(
    [
      { id: "a", usage: usage(10, 100), policy: none },
      { id: "b", usage: usage(50, 20), policy: none },
      { id: "c", usage: usage(30, 60), policy: none },
    ],
    NOW,
  );
  expect(r).toEqual(["b", "c", "a"]);
});

test("ties keep the existing order", () => {
  const r = rankByWeeklyReset(
    [
      { id: "a", usage: usage(10, 20), policy: none },
      { id: "b", usage: usage(90, 20), policy: none },
    ],
    NOW,
  );
  expect(r).toEqual(["a", "b"]);
});

test("cap excludes an account until the final window lifts it", () => {
  const over = (resetIn: number) => rankByWeeklyReset([{ id: "a", usage: usage(75, resetIn), policy: cap70 }], NOW);
  expect(over(100)).toEqual([]);
  expect(over(24)).toEqual(["a"]);
  expect(over(10)).toEqual(["a"]);
});

test("cap without release stays", () => {
  const s = weeklyState(usage(80, 1), NOW);
  expect(overCap(s, { capPercent: 70, releaseHours: null }, NOW)).toBe(true);
});

test("missing, stale or past data ranks last and is never capped", () => {
  const r = rankByWeeklyReset(
    [
      { id: "none", usage: null, policy: cap70 },
      { id: "stale", usage: usage(99, 100, 7), policy: cap70 },
      { id: "past", usage: usage(99, -1), policy: cap70 },
      { id: "nowindow", usage: { windows: [], source: "turn", at: h(0) }, policy: cap70 },
      { id: "ok", usage: usage(10, 100), policy: cap70 },
    ],
    NOW,
  );
  expect(r).toEqual(["ok", "none", "stale", "past", "nowindow"]);
});

test("concurrent starts: a claimed account is pushed over its cap", () => {
  const res = new Reservations();
  const c = [
    { id: "a", usage: usage(68, 100), policy: cap70 },
    { id: "b", usage: usage(40, 120), policy: cap70 },
  ];
  expect(rankByWeeklyReset(c, NOW, (id) => res.percent(id, NOW))).toEqual(["a", "b"]);
  res.claim("a", NOW);
  expect(rankByWeeklyReset(c, NOW, (id) => res.percent(id, NOW))).toEqual(["b"]);
  // claims expire
  expect(res.percent("a", NOW + 31_000)).toBe(0);
});
