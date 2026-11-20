import type { PlanUsage, PlanWindow } from "@agenteschat/adapters";

/**
 * Weekly-quota distribution among a pool of accounts of one provider: prefer the account whose weekly window
 * resets soonest (its unused quota would otherwise be lost), within each account's configurable cap, which is lifted
 * in the final window before the reset. Pure: the caller supplies the stored usage and the clock.
 */
export interface WeeklyPolicy {
  /** Stop sending runs to the account once its week is this used (0–100). Null: no cap. */
  capPercent: number | null;
  /** Lift the cap this many hours before the weekly reset. Null or 0: never lifted. */
  releaseHours: number | null;
}

/** A reading older than this is stale: the account is ranked after fresh ones and never capped on it. */
export const WEEKLY_STALE_MS = 6 * 3600_000;
/** An account picked this recently by a concurrent start counts as `RESERVE_PERCENT` more used. */
export const RESERVE_TTL_MS = 30_000;
export const RESERVE_PERCENT = 2;

export type WeeklyState =
  | { kind: "known"; usedPercent: number; resetsAt: number }
  | { kind: "unknown" };

/** The weekly window of a reading (`seven_day`), when it is present, fresh and has a future reset. */
export function weeklyState(usage: PlanUsage | null | undefined, now: number): WeeklyState {
  const w: PlanWindow | undefined = usage?.windows.find((x) => x.kind === "seven_day");
  if (!usage || !w || !w.resetsAt) return { kind: "unknown" };
  const reset = Date.parse(w.resetsAt);
  const seen = Date.parse(w.at ?? usage.at);
  if (!Number.isFinite(reset) || reset <= now || !Number.isFinite(seen) || now - seen > WEEKLY_STALE_MS)
    return { kind: "unknown" };
  const used = Number(w.usedPercent);
  if (!Number.isFinite(used)) return { kind: "unknown" };
  return { kind: "known", usedPercent: Math.min(100, Math.max(0, used)), resetsAt: reset };
}

/** Whether the cap holds now: false inside the final window (`releaseHours`) and when the reading is unknown. */
export function overCap(state: WeeklyState, policy: WeeklyPolicy, now: number, reserved = 0): boolean {
  if (state.kind !== "known" || policy.capPercent === null) return false;
  if (policy.releaseHours && state.resetsAt - now <= policy.releaseHours * 3600_000) return false;
  return state.usedPercent + reserved >= policy.capPercent;
}

export interface WeeklyCandidate {
  id: string;
  usage: PlanUsage | null;
  policy: WeeklyPolicy;
}

/**
 * Candidate ids in the order to try: known readings by nearest weekly reset first, then unknown/stale ones, each
 * keeping its input order on ties; accounts over their cap are dropped. Short limits (five hours) are the caller's
 * own check (`computerBrainUnavailable`), which still applies to what this returns.
 */
export function rankByWeeklyReset(
  candidates: readonly WeeklyCandidate[],
  now: number,
  reserved: (id: string) => number = () => 0,
): string[] {
  const known: { id: string; at: number; i: number }[] = [];
  const unknown: string[] = [];
  candidates.forEach((c, i) => {
    const s = weeklyState(c.usage, now);
    if (overCap(s, c.policy, now, reserved(c.id))) return;
    if (s.kind === "known") known.push({ id: c.id, at: s.resetsAt, i });
    else unknown.push(c.id);
  });
  known.sort((a, b) => a.at - b.at || a.i - b.i);
  return [...known.map((k) => k.id), ...unknown];
}

/** Short-lived in-process claims so simultaneous starts spread over accounts instead of all taking the first. */
export class Reservations {
  private claims = new Map<string, number[]>();
  claim(id: string, now: number): void {
    this.claims.set(id, [...this.live(id, now), now]);
  }
  percent(id: string, now: number): number {
    return this.live(id, now).length * RESERVE_PERCENT;
  }
  private live(id: string, now: number): number[] {
    const l = (this.claims.get(id) ?? []).filter((t) => now - t < RESERVE_TTL_MS);
    if (l.length) this.claims.set(id, l);
    else this.claims.delete(id);
    return l;
  }
}
