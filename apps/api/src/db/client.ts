import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function createDb(url: string): Sql {
  // Supabase's pooler runs in transaction mode on port 6543, which cannot use prepared statements.
  return postgres(url, { prepare: false, max: 5, idle_timeout: 20 });
}
