import { sql } from 'drizzle-orm';

/** `id IN (...)` fragment for bigint swap ids; empty → caller must skip. */
export function sqlSwapIds(ids: bigint[]): ReturnType<typeof sql.join> | null {
  if (ids.length === 0) return null;
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}
