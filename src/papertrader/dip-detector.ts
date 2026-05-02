import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';
import type { DipContext, SnapshotCandidateRow } from './types.js';

function sourceSnapshotTable(source: string): string | null {
  if (source === 'raydium') return 'raydium_pair_snapshots';
  if (source === 'meteora') return 'meteora_pair_snapshots';
  if (source === 'orca') return 'orca_pair_snapshots';
  if (source === 'moonshot') return 'moonshot_pair_snapshots';
  if (source === 'pumpswap') return 'pumpswap_pair_snapshots';
  return null;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Per-mint high/low for each lookback window (minutes). */
export type DipContextByWindows = Map<number, DipContext>;

/**
 * Fetch MAX/MIN price_usd per mint per configured window in one scan (WHERE capped at max window).
 */
export async function fetchDipContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, DipContextByWindows>> {
  const map = new Map<string, DipContextByWindows>();
  const windows = cfg.dipAggregationWindowsMin;
  const maxWin = Math.max(...windows);
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const t = sourceSnapshotTable(r.source);
    if (!t) continue;
    const arr = byTable.get(t) ?? [];
    arr.push(r.mint);
    byTable.set(t, arr);
  }

  const aggCols = windows
    .map(
      (w) =>
        `MAX(COALESCE(price_usd, 0)) FILTER (WHERE ts >= now() - interval '${w} minutes')::float AS high_w${w},\n` +
        `        MIN(NULLIF(COALESCE(price_usd, 0), 0)) FILTER (WHERE ts >= now() - interval '${w} minutes' AND COALESCE(price_usd, 0) > 0)::float AS low_w${w}`,
    )
    .join(',\n        ');

  for (const [table, mintsRaw] of byTable.entries()) {
    const uniq = [...new Set(mintsRaw)];
    if (!uniq.length) continue;
    const mintsSql = uniq.map(sqlQuote).join(',');
    const r = await db.execute(dsql.raw(`
      SELECT
        base_mint AS mint,
        ${aggCols}
      FROM ${table}
      WHERE ts >= now() - interval '${maxWin} minutes'
        AND base_mint IN (${mintsSql})
      GROUP BY base_mint
    `));
    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const inner = new Map<number, DipContext>();
      for (const w of windows) {
        const hi = row[`high_w${w}`];
        const lo = row[`low_w${w}`];
        inner.set(w, {
          high_px: Number(hi ?? 0) || 0,
          low_px: Number(lo ?? 0) || 0,
        });
      }
      map.set(mint, inner);
    }
  }
  return map;
}

export interface DipEvalResult {
  reasons: string[];
  dipPct: number | null;
  impulsePct: number | null;
  /** Window (minutes) whose high/low satisfied the dip gate; null if none passed. */
  dipLookbackUsedMin: number | null;
}

/** Single-window dip math (impulse = range within that same window). */
export function evaluateDipOneWindow(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: DipContext | null,
): Omit<DipEvalResult, 'dipLookbackUsedMin'> {
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

/**
 * OR across `cfg.dipLookbackWindowsMin`: pass if any window satisfies the same dip / impulse bounds.
 * On pass, `dip_pct` / `impulse_pct` / `dipLookbackUsedMin` refer to the **first** passing window (shortest lookback first).
 */
export function evaluateDip(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow?: DipContextByWindows | null,
): DipEvalResult {
  if (!ctxByWindow || ctxByWindow.size === 0) {
    return {
      reasons: ['dip_ctx_missing'],
      dipPct: null,
      impulsePct: null,
      dipLookbackUsedMin: null,
    };
  }
  const failHints: string[] = [];
  for (const w of cfg.dipLookbackWindowsMin) {
    const ctx = ctxByWindow.get(w);
    const part = evaluateDipOneWindow(cfg, row, ctx);
    if (part.reasons.length === 0) {
      return {
        reasons: [],
        dipPct: part.dipPct,
        impulsePct: part.impulsePct,
        dipLookbackUsedMin: w,
      };
    }
    failHints.push(`${w}m:${part.reasons[0]}`);
  }
  return {
    reasons: [`dip_no_window_pass(${failHints.join(';')})`],
    dipPct: null,
    impulsePct: null,
    dipLookbackUsedMin: null,
  };
}

export type RecoveryVetoResult = {
  reasons: string[];
  bounces: Record<number, number>;
};

export function evaluateRecoveryVeto(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | null | undefined,
  dipLookbackUsedMin: number | null,
): RecoveryVetoResult {
  const bounces: Record<number, number> = {};
  if (!cfg.dipRecoveryVetoEnabled || cfg.dipRecoveryVetoWindowsMin.length === 0) {
    return { reasons: [], bounces };
  }
  if (!ctxByWindow || dipLookbackUsedMin == null) {
    return { reasons: [], bounces };
  }
  const price = Number(row.price_usd);
  if (!(price > 0)) {
    return { reasons: [], bounces };
  }

  const reasons: string[] = [];
  const thr = cfg.dipRecoveryVetoMaxBouncePct;

  for (const v of cfg.dipRecoveryVetoWindowsMin) {
    if (v >= dipLookbackUsedMin) continue;
    const ctx = ctxByWindow.get(v);
    if (!ctx || !(ctx.low_px > 0)) continue;
    const bounce = (price / ctx.low_px - 1) * 100;
    bounces[v] = +bounce.toFixed(2);
    if (bounce >= thr) {
      reasons.push(`recovery_veto_${v}m_bounce${bounces[v].toFixed(1)}>=${thr}%`);
    }
  }

  return { reasons, bounces };
}
