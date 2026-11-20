import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema, sql, weeklyQuotaPolicy } from "@agenteschat/db";
import { type BrainPlan, clearPlanLimits } from "../src";
import { nextAccountPlan } from "../src/spill";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** The fork's per-account weekly policy lives in `wenovlab.weekly_quota_policy`, not on the official tables. */

let f: Fixture | undefined;
afterEach(() => {
  clearPlanLimits();
  const fx = f;
  f = undefined;
  return fx?.close();
});

const OWN1 = "0193eeee-0000-4000-8000-00000000a001";
const OWN2 = "0193eeee-0000-4000-8000-00000000a002";
const OWN3 = "0193eeee-0000-4000-8000-00000000a003";
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const week = (used: number, resetsInHours: number) => ({
  windows: [{ kind: "seven_day", usedPercent: used, resetsAt: hours(resetsInHours) }],
  source: "turn",
  at: new Date().toISOString(),
});

test("per-account cap and final-window release read the fork table", async () => {
  f = await setup({});
  const fx = f;
  const deps0 = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const { machineId } = await pairMachine(deps0, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  for (const id of [OWN1, OWN2, OWN3])
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id.slice(-4),
      status: "active",
      createdBy: fx.owner.id,
      shared: true,
    });
  await fx.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainModel: "sonnet", brainAccountId: OWN1 })
    .where(eq(schema.agents.id, fx.agent.id));
  // OWN2 resets soonest (1 day) but is at 80%; OWN3 resets in 3 days at 20%.
  const set = (id: string, w: unknown) =>
    fx.db
      .update(schema.machineAccounts)
      .set({ usage: w as never })
      .where(eq(schema.machineAccounts.id, id));
  await set(OWN2, week(80, 24));
  await set(OWN3, week(20, 72));
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id));
  if (!agent) throw new Error("no agent");
  const plan: BrainPlan = {
    kind: "claude_code",
    model: "sonnet",
    session: { id: "s1", resume: true, machineId, cwd: "" },
    account: { id: OWN1, label: "a001", status: "active" },
  };
  const deps = {
    db: fx.db,
    machines: {
      status: async (id: string) => ({
        id,
        orgId: "org",
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: MACHINE_PROTOCOL_VERSION,
        executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
  };
  const pick = async () => (await nextAccountPlan(deps, agent, plan, [OWN1])).plan?.account?.id;

  // No policy row: nearest weekly reset first.
  expect(await pick()).toBe(OWN2);
  // Cap 70 on OWN2 (at 80%), reset 24 h away: skipped.
  await fx.db.insert(weeklyQuotaPolicy).values({ orgId: fx.org.id, machineAccountId: OWN2, capPercent: 70 });
  expect(await pick()).toBe(OWN3);
  // Cap lifted inside the last 48 h: OWN2 again.
  await fx.db.update(weeklyQuotaPolicy).set({ releaseHours: 48 }).where(eq(weeklyQuotaPolicy.machineAccountId, OWN2));
  expect(await pick()).toBe(OWN2);
  // The row goes with its account.
  await fx.db.update(weeklyQuotaPolicy).set({ releaseHours: null });
  await fx.db.delete(schema.machineAccounts).where(eq(schema.machineAccounts.id, OWN2));
  const left = await fx.db.execute(sql`select count(*)::int n from wenovlab.weekly_quota_policy`);
  expect(JSON.stringify(left)).toContain('"n":0');
});
