import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { foreignKey, integer, pgSchema, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { machineAccounts } from "./schema";

/**
 * Wenovlab fork additions, kept apart from the official schema so official updates merge cleanly: its own Postgres
 * schema (`wenovlab`), its own migrations folder (`fork/migrations`) and its own registry (`wenovlab.fork_migrations`).
 * Nothing here is in the official journal or in `drizzle.__drizzle_migrations`, and the table is not exported from
 * `./schema`, so `drizzle-kit generate` never sees it. Run after the official migrations (`DatabaseHandle.migrate`).
 */
export const forkMigrationsFolder = resolve(import.meta.dir, "../fork/migrations");

const wenovlab = pgSchema("wenovlab");

/** Weekly-quota spreading per account: no cap row (or null values) = no cap, the official behavior. */
export const weeklyQuotaPolicy = wenovlab.table(
  "weekly_quota_policy",
  {
    orgId: uuid("org_id").notNull(),
    machineAccountId: uuid("machine_account_id").notNull(),
    /** Stop sending runs once the week is this used (0-100); null: no cap. */
    capPercent: integer("cap_percent"),
    /** Hours before the weekly reset from which the cap no longer holds; null or 0: never lifted. */
    releaseHours: integer("release_hours"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.machineAccountId] }),
    foreignKey({
      columns: [t.orgId, t.machineAccountId],
      foreignColumns: [machineAccounts.orgId, machineAccounts.id],
    }).onDelete("cascade"),
  ],
);

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows: T[] }).rows ?? [])) as T[];

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/** Lock of its own (the official one is `MIGRATIONS_LOCK`): taken inside the official lock's section, never before. */
const FORK_LOCK = 4_242_018;

/**
 * Applies the fork's pending migrations in file order, each file in one transaction together with its registry row.
 * Idempotent: a recorded file is skipped, and a recorded file whose text changed is an error (same rule as the
 * official migrations: fixes go in a new file).
 */
export async function migrateFork(
  db: Exec & { transaction: (f: (tx: Exec) => Promise<void>) => Promise<void> },
  folder = forkMigrationsFolder,
) {
  await db.execute(sql`create schema if not exists wenovlab`);
  await db.execute(
    sql`create table if not exists wenovlab.fork_migrations (name text primary key, hash text not null, applied_at timestamptz not null default now())`,
  );
  const files = readdirSync(folder)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const text = readFileSync(`${folder}/${name}`, "utf8");
    const hash = createHash("sha256").update(text).digest("hex");
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${FORK_LOCK}::bigint)`);
      const done = rowsOf<{ hash: string }>(
        await tx.execute(sql`select hash from wenovlab.fork_migrations where name = ${name}`),
      );
      if (done[0]) {
        if (done[0].hash !== hash)
          throw new Error(`Fork migration ${name} was changed after it was applied. Restore it and add a new file.`);
        return;
      }
      for (const stmt of text.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`insert into wenovlab.fork_migrations (name, hash) values (${name}, ${hash})`);
    });
  }
}
