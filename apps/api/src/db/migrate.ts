/**
 * Applies new SQL files from supabase/migrations to your database, in order, once each.
 * Run with:  npm run db:migrate -w @sitemate/api
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client";

const dir = fileURLToPath(new URL("../../../../supabase/migrations", import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing from apps/api/.env");
  const db = createDb(url);

  try {
    await db`create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())`;
    await db`alter table public._migrations enable row level security`;
    const done = new Set((await db<{ name: string }[]>`select name from public._migrations`).map((r) => r.name));

    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) {
        console.log(`✓ ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf8");
      await db.begin(async (tx) => {
        await tx.unsafe(sql);
        await tx`insert into public._migrations (name) values (${file})`;
      });
      console.log(`✓ ${file} applied`);
    }
    console.log("Database is up to date.");
  } finally {
    await db.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`✗ Migration failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
