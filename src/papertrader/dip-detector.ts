import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from './config.js';
import type { DipContext, SnapshotCandidateRow } from './types.js';

/** Имя таблицы PG-снимков по `pair_snapshots` для источника пула (dip / tp-regime). */
export function sourceSnapshotTable(source: string): string | null {
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
  /**
   * Per-window dip% (last_price/high - 1) for every configured window where ctx existed.
   * Always populated regardless of pass/fail — for retro telemetry: "how close were we to threshold".
   * Empty object if no ctx at all.
   */
  perWindowDipPct: Record<number, number>;
}

/** Single-window dip math (impulse = range within that same window). */
export function evaluateDipOneWindow(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: DipContext | null,
): Omit<DipEvalResult, 'dipLookbackUsedMin' | 'perWindowDipPct'> {
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
      perWindowDipPct: {},
    };
  }
  const failHints: string[] = [];
  const perWindowDipPct: Record<number, number> = {};
  for (const w of cfg.dipLookbackWindowsMin) {
    const ctx = ctxByWindow.get(w);
    const part = evaluateDipOneWindow(cfg, row, ctx);
    if (part.dipPct !== null) perWindowDipPct[w] = +part.dipPct.toFixed(2);
    if (part.reasons.length === 0) {
      return {
        reasons: [],
        dipPct: part.dipPct,
        impulsePct: part.impulsePct,
        dipLookbackUsedMin: w,
        perWindowDipPct,
      };
    }
    failHints.push(`${w}m:${part.reasons[0]}`);
  }
  return {
    reasons: [`dip_no_window_pass(${failHints.join(';')})`],
    dipPct: null,
    impulsePct: null,
    dipLookbackUsedMin: null,
    perWindowDipPct,
  };
}

export type RecoveryVetoResult = {
  reasons: string[];
  bounces: Record<number, number>;
};

export type RecoveryVetoOptions = {
  maxBouncePct?: number;
  windowsMin?: number[];
  /** Dip depth (negative %) — deep dips get a higher bounce allowance when dip-scaled enabled. */
  dipPct?: number | null;
};

export type LocalHighVetoResult = {
  reasons: string[];
  distanceFromHighPct: Record<number, number>;
};

export function evaluateRecoveryVeto(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | null | undefined,
  dipLookbackUsedMin: number | null,
  opts?: RecoveryVetoOptions,
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
  let thr = opts?.maxBouncePct ?? cfg.dipRecoveryVetoMaxBouncePct;
  const dipPct = opts?.dipPct;
  if (
    cfg.dipRecoveryVetoDipScaledEnabled &&
    dipPct != null &&
    dipPct < 0 &&
    Number.isFinite(dipPct)
  ) {
    const excess = Math.max(0, -dipPct - cfg.dipRecoveryVetoDipScaledFloorPct);
    thr += excess * cfg.dipRecoveryVetoDipScaledBonusPerPoint;
  }
  const windows = opts?.windowsMin ?? cfg.dipRecoveryVetoWindowsMin;

  for (const v of windows) {
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

export function evaluateLocalHighVeto(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | null | undefined,
): LocalHighVetoResult {
  const distanceFromHighPct: Record<number, number> = {};
  if (!cfg.dipLocalHighVetoEnabled || cfg.dipLocalHighVetoWindowsMin.length === 0) {
    return { reasons: [], distanceFromHighPct };
  }
  if (!ctxByWindow || ctxByWindow.size === 0) {
    return { reasons: [], distanceFromHighPct };
  }
  const price = Number(row.price_usd);
  if (!(price > 0)) {
    return { reasons: [], distanceFromHighPct };
  }

  const reasons: string[] = [];
  const thr = cfg.dipLocalHighVetoMaxDistancePct;
  for (const v of cfg.dipLocalHighVetoWindowsMin) {
    const ctx = ctxByWindow.get(v);
    if (!ctx || !(ctx.high_px > 0)) continue;
    const distance = Math.max(0, (ctx.high_px / price - 1) * 100);
    distanceFromHighPct[v] = +distance.toFixed(2);
    if (distance <= thr) {
      reasons.push(`local_high_veto_${v}m_dist${distanceFromHighPct[v].toFixed(1)}<=${thr}%`);
    }
  }

  return { reasons, distanceFromHighPct };
}

export type RollingFlushVetoResult = {
  reasons: string[];
  dumpFromHighPct: Record<number, number>;
};

/**
 * Rolling-flush entry veto (anti «затухающая горка» / падающий нож).
 *
 * Blocks entry when the coin is a falling knife right now: for some window it is down
 * `>= dipRollingFlushVetoMinDumpPct` from that window's high (and not more than
 * `dipRollingFlushVetoMaxDumpPct`, so already-collapsed/dead mints are left to other guards)
 * AND the current price is still within `dipRollingFlushVetoNearLowPct` of the window LOW —
 * i.e. it fell hard and has NOT bounced yet (still at the fresh bottom). A stabilized dip that
 * has bounced off its low passes (that is a real dip, not a knife); the recovery/local-high
 * vetos cover the over-bounced end. Same dump-from-window-high math as `detectRollingFlush`
 * (knife-flush-detector), on aggregated PG window highs/lows instead of a tick buffer.
 *
 * Calibrated on DEXBULL (bought 2026-07-10 16:22 on a fresh 30m/60m low, −17%/−21% from the
 * window high with zero bounce, then rugged to −99%): the 10–15m dump was only ~4%, so the
 * default windows include 30m/60m to catch the slower fade.
 */
export function evaluateRollingFlushVeto(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | null | undefined,
): RollingFlushVetoResult {
  const dumpFromHighPct: Record<number, number> = {};
  if (!cfg.dipRollingFlushVetoEnabled || cfg.dipRollingFlushVetoWindowsMin.length === 0) {
    return { reasons: [], dumpFromHighPct };
  }
  if (!ctxByWindow || ctxByWindow.size === 0) {
    return { reasons: [], dumpFromHighPct };
  }
  const price = Number(row.price_usd);
  if (!(price > 0)) {
    return { reasons: [], dumpFromHighPct };
  }

  const reasons: string[] = [];
  const minDump = cfg.dipRollingFlushVetoMinDumpPct;
  const maxDump = cfg.dipRollingFlushVetoMaxDumpPct;
  const nearLowPct = cfg.dipRollingFlushVetoNearLowPct;
  for (const w of cfg.dipRollingFlushVetoWindowsMin) {
    const ctx = ctxByWindow.get(w);
    if (!ctx || !(ctx.high_px > 0)) continue;
    const dump = ((ctx.high_px - price) / ctx.high_px) * 100;
    dumpFromHighPct[w] = +dump.toFixed(2);
    if (dump < minDump || dump > maxDump) continue;
    // Still-falling check: current price at/near the window low = no real bounce yet (a knife).
    if (nearLowPct > 0 && ctx.low_px > 0) {
      const aboveLowPct = (price / ctx.low_px - 1) * 100;
      if (aboveLowPct > nearLowPct) continue; // already bounced off the low → a dip, not a knife
    }
    reasons.push(`rolling_flush_veto_${w}m_dump${dump.toFixed(1)}%_atlow`);
  }

  return { reasons, dumpFromHighPct };
}
