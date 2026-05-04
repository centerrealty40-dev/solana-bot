/**
 * 12h snapshot-based regime label → per-trade TP grid overrides (paper fork).
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import { sourceSnapshotTable } from '../dip-detector.js';
import type { OpenTrade, TpGridOverrides, TpRegime } from '../types.js';

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchPricePathStats(args: {
  table: string;
  mint: string;
  lookbackMin: number;
}): Promise<{ n: number; firstPx: number; lastPx: number; hi: number; lo: number } | null> {
  const { table, mint, lookbackMin } = args;
  const q = `
    SELECT
      COUNT(*)::int AS n,
      MIN(price_usd) FILTER (WHERE COALESCE(price_usd, 0) > 0)::float AS lo,
      MAX(price_usd)::float AS hi,
      (array_agg(price_usd ORDER BY ts ASC) FILTER (WHERE COALESCE(price_usd, 0) > 0))[1]::float AS first_px,
      (array_agg(price_usd ORDER BY ts DESC) FILTER (WHERE COALESCE(price_usd, 0) > 0))[1]::float AS last_px
    FROM ${table}
    WHERE base_mint = ${sqlQuote(mint)}
      AND ts >= now() - interval '${Math.floor(lookbackMin)} minutes'
      AND COALESCE(price_usd, 0) > 0
  `;
  const r = await db.execute(dsql.raw(q));
  const row = (r as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  const n = Number(row.n ?? 0);
  const firstPx = Number(row.first_px ?? 0);
  const lastPx = Number(row.last_px ?? 0);
  const hi = Number(row.hi ?? 0);
  const lo = Number(row.lo ?? 0);
  if (!(n > 0) || !(firstPx > 0) || !(lastPx > 0) || !(hi > 0) || !(lo > 0)) return null;
  return { n, firstPx, lastPx, hi, lo };
}

function classifyRegime(args: {
  cfg: PaperTraderConfig;
  netMovePct: number;
  rangePct: number;
  n: number;
}): TpRegime {
  const { cfg, netMovePct, rangePct, n } = args;
  if (n < cfg.tpRegimeMinSamples) return 'unknown';
  if (netMovePct <= cfg.tpRegimeDownNetPct) return 'down';
  if (netMovePct >= cfg.tpRegimeUpNetPct) return 'up';
  if (
    Math.abs(netMovePct) <= cfg.tpRegimeSidewaysAbsNetPct &&
    rangePct >= cfg.tpRegimeSidewaysMinRangePct
  ) {
    return 'sideways';
  }
  return 'unknown';
}

function overridesForRegime(regime: TpRegime, cfg: PaperTraderConfig): TpGridOverrides | undefined {
  if (regime === 'up' || regime === 'unknown') return undefined;
  if (regime === 'down') {
    return {
      gridStepPnl: cfg.tpGridStepPnl,
      gridSellFraction: 1,
      gridMaxRungs: 1,
      gridFirstRungRetraceMinPnlPct: cfg.tpGridFirstRungRetraceMinPnlPct,
    };
  }
  /* sideways */
  return {
    gridMaxRungs: 2,
  };
}

/**
 * Mutates `ot` with `tpRegime`, `tpRegimeFeatures`, `tpGridOverrides` when enabled.
 */
export async function resolveTpRegimeForOpen(cfg: PaperTraderConfig, ot: OpenTrade): Promise<void> {
  if (!cfg.tpRegimeEnabled) return;
  const table = sourceSnapshotTable(ot.source ?? '');
  if (!table) {
    ot.tpRegime = 'unknown';
    ot.tpRegimeFeatures = { netMovePct: 0, rangePct: 0, sampleCount: 0, table: null };
    ot.tpGridOverrides = undefined;
    return;
  }

  const stats = await fetchPricePathStats({
    table,
    mint: ot.mint,
    lookbackMin: cfg.tpRegimeLookbackMin,
  });
  if (!stats) {
    ot.tpRegime = 'unknown';
    ot.tpRegimeFeatures = { netMovePct: 0, rangePct: 0, sampleCount: 0, table };
    ot.tpGridOverrides = undefined;
    return;
  }

  const netMovePct = (stats.lastPx / stats.firstPx - 1) * 100;
  const rangePct = (stats.hi / stats.lo - 1) * 100;
  const regime = classifyRegime({
    cfg,
    netMovePct,
    rangePct,
    n: stats.n,
  });
  ot.tpRegime = regime;
  ot.tpRegimeFeatures = {
    netMovePct: +netMovePct.toFixed(4),
    rangePct: +rangePct.toFixed(4),
    sampleCount: stats.n,
    table,
  };
  ot.tpGridOverrides = overridesForRegime(regime, cfg);
}
