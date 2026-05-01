import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';
import type { DipContext, SnapshotCandidateRow } from './types.js';

function sourceSnapshotTable(source: string): string | null {
  if (source === 'raydium') return 'raydium_pair_snapshots';
  if (source === 'meteora') return 'meteora_pair_snapshots';
  if (source === 'orca') return 'orca_pair_snapshots';
  if (source === 'moonshot') return 'moonshot_pair_snapshots';
  return null;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchDipContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, DipContext>> {
  const map = new Map<string, DipContext>();
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const t = sourceSnapshotTable(r.source);
    if (!t) continue;
    const arr = byTable.get(t) ?? [];
    arr.push(r.mint);
    byTable.set(t, arr);
  }

  for (const [table, mintsRaw] of byTable.entries()) {
    const uniq = [...new Set(mintsRaw)];
    if (!uniq.length) continue;
    const mintsSql = uniq.map(sqlQuote).join(',');
    const r = await db.execute(dsql.raw(`
      SELECT
        base_mint AS mint,
        MAX(COALESCE(price_usd, 0))::float AS high_px,
        MIN(NULLIF(COALESCE(price_usd, 0), 0))::float AS low_px
      FROM ${table}
      WHERE ts >= now() - interval '${cfg.dipLookbackMin} minutes'
        AND base_mint IN (${mintsSql})
      GROUP BY base_mint
    `));
    const out = r as unknown as Array<{ mint: string; high_px: number | string; low_px: number | string }>;
    for (const row of out) {
      map.set(String(row.mint), {
        high_px: Number(row.high_px || 0),
        low_px: Number(row.low_px || 0),
      });
    }
  }
  return map;
}

export function evaluateDip(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: DipContext | null,
): { reasons: string[]; dipPct: number | null; impulsePct: number | null } {
  const reasons: string[] = [];
  if ((row.token_age_min ?? 0) < cfg.dipMinAgeMin) reasons.push(`dip_age<${cfg.dipMinAgeMin}m`);
  if (!ctx || !(ctx.high_px > 0)) {
    return { reasons: [...reasons, 'dip_ctx_missing'], dipPct: null, impulsePct: null };
  }
  const dipPct = (row.price_usd / ctx.high_px - 1) * 100;
  if (dipPct > cfg.dipMinDropPct) reasons.push(`dip_not_deep_enough>${cfg.dipMinDropPct}%`);
  if (dipPct < cfg.dipMaxDropPct) reasons.push(`dip_too_deep<${cfg.dipMaxDropPct}%`);
  const impulsePct = ctx.low_px > 0 ? (ctx.high_px / ctx.low_px - 1) * 100 : null;
  if ((impulsePct ?? 0) < cfg.dipMinImpulsePct) reasons.push(`impulse<${cfg.dipMinImpulsePct}%`);
  return { reasons, dipPct, impulsePct };
}
