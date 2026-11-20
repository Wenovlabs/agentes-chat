import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { createDatabase, migrateInSteps, migrationsFolder } from "../src/client";
import { forkMigrationsFolder, migrateFork, weeklyQuotaPolicy } from "../src/fork";
import { assertMigrationsMatch, knownMigrations } from "../src/migration-guard";
import * as schema from "../src/schema";

/** The fork's tables live in schema `wenovlab` with their own registry: the official journal and registry are untouched. */

const ORG = "0193eeee-0000-4000-8000-0000000000a0";
const MACHINE = "0193eeee-0000-4000-8000-0000000000b0";
const ACC = "0193eeee-0000-4000-8000-0000000000c0";
const one = async (c: PGlite, q: string) => (await c.query(q)).rows[0] as Record<string, unknown>;
const open = () => {
  const client = new PGlite({ extensions: { vector } });
  return { client, db: drizzle(client, { schema, casing: "snake_case" }) };
};
async function seedAccount(db: ReturnType<typeof open>["db"]) {
  await db.insert(schema.organizations).values({ id: ORG, name: "Acme" });
  await db.insert(schema.machines).values({ id: MACHINE, orgId: ORG, name: "m" });
  await db
    .insert(schema.machineAccounts)
    .values({ id: ACC, orgId: ORG, machineId: MACHINE, kind: "claude_code", label: "a" });
}

describe("fork migrations", () => {
  test("fresh install: official journal untouched, fork registry apart, no fork column on official tables", async () => {
    expect(knownMigrations(migrationsFolder).some((m) => /weekly/.test(m.tag))).toBe(false);
    const { client, db } = open();
    await migrateInSteps(db, migrationsFolder);
    await migrateFork(db as never);
    expect((await one(client, "select count(*)::int n from drizzle.__drizzle_migrations")).n).toBe(
      knownMigrations(migrationsFolder).length,
    );
    await assertMigrationsMatch(db as never, migrationsFolder);
    expect((await one(client, "select array_agg(name) n from wenovlab.fork_migrations")).n).toEqual([
      "0001_weekly_quota_policy.sql",
    ]);
    expect(
      (
        await one(
          client,
          "select count(*)::int n from information_schema.columns where table_name='machine_accounts' and column_name like 'weekly%'",
        )
      ).n,
    ).toBe(0);
  });

  test("existing official database progresses; a later official migration (even numbered 0309) applies with fork data kept; restart is idempotent", async () => {
    const { client, db } = open();
    await migrateInSteps(db, migrationsFolder); // an installation of the official schema, no fork yet
    await seedAccount(db);
    await migrateFork(db as never);
    await db.insert(weeklyQuotaPolicy).values({ orgId: ORG, machineAccountId: ACC, capPercent: 70, releaseHours: 24 });

    // What upstream would ship next: its own 0309, on the same journal slot the fork used to take.
    const later = mkdtempSync(join(tmpdir(), "official-later-"));
    cpSync(migrationsFolder, later, { recursive: true });
    const journal = JSON.parse(readFileSync(join(later, "meta/_journal.json"), "utf8"));
    const last = journal.entries.at(-1);
    journal.entries.push({
      idx: last.idx + 1,
      version: "7",
      when: last.when + 1000,
      tag: "0309_official_next",
      breakpoints: true,
    });
    writeFileSync(join(later, "meta/_journal.json"), JSON.stringify(journal));
    writeFileSync(
      join(later, "0309_official_next.sql"),
      'ALTER TABLE "machine_accounts" ADD COLUMN "official_next" integer;',
    );
    await assertMigrationsMatch(db as never, later);
    await migrateInSteps(db, later);
    await migrateFork(db as never);
    await assertMigrationsMatch(db as never, later);

    expect(
      (
        await one(
          client,
          "select count(*)::int n from information_schema.columns where table_name='machine_accounts' and column_name='official_next'",
        )
      ).n,
    ).toBe(1);
    expect(await one(client, "select cap_percent, release_hours from wenovlab.weekly_quota_policy")).toEqual({
      cap_percent: 70,
      release_hours: 24,
    });
    // Restart: nothing runs twice.
    await migrateInSteps(db, later);
    await migrateFork(db as never);
    expect((await one(client, "select count(*)::int n from wenovlab.fork_migrations")).n).toBe(1);
    expect((await one(client, "select count(*)::int n from wenovlab.weekly_quota_policy")).n).toBe(1);
    rmSync(later, { recursive: true });
  });

  test("a changed fork file is refused", async () => {
    const { db } = open();
    await migrateInSteps(db, migrationsFolder);
    await migrateFork(db as never);
    const dir = mkdtempSync(join(tmpdir(), "forkmig-"));
    const name = "0001_weekly_quota_policy.sql";
    writeFileSync(join(dir, name), `${readFileSync(join(forkMigrationsFolder, name), "utf8")}\n-- edited`);
    await expect(migrateFork(db as never, dir)).rejects.toThrow("changed after it was applied");
  });

  test("a database that ran the retired official 0309 keeps its quota values", async () => {
    const { client, db } = open();
    await migrateInSteps(db, migrationsFolder);
    await seedAccount(db);
    await client.exec(
      "alter table machine_accounts add column weekly_cap_percent integer, add column weekly_release_hours integer; update machine_accounts set weekly_cap_percent = 65, weekly_release_hours = 12",
    );
    await migrateFork(db as never);
    expect(await one(client, "select cap_percent, release_hours, org_id from wenovlab.weekly_quota_policy")).toEqual({
      cap_percent: 65,
      release_hours: 12,
      org_id: ORG,
    });
  });

  describe("boot path (createDatabase, native folder)", () => {
    let root = "";
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "fork-boot-"));
      mkdirSync(join(root, "x"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    test("migrate() creates the fork table and a second boot changes nothing", async () => {
      const url = `pglite://${join(root, "db")}`;
      const first = createDatabase({ url, poolMax: 1 });
      await first.migrate();
      await seedAccount(first.db as never);
      await first.db.insert(weeklyQuotaPolicy).values({ orgId: ORG, machineAccountId: ACC, capPercent: 50 });
      await first.close();
      const again = createDatabase({ url, poolMax: 1 });
      await again.migrate();
      const rows = await again.db.select().from(weeklyQuotaPolicy);
      expect(rows.map((r) => r.capPercent)).toEqual([50]);
      await again.close();
    });
  });
});
