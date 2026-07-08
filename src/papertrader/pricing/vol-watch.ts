/**
 * VOL_COLLAPSE — rolling-volume drain watch.
 *
 * Sibling of W7.5 liquidity-drain watch ({@link ./liq-watch}). Where liq-watch tracks pool
 * liquidity vs an entry baseline, this tracks rolling 1h traded volume vs a high-water baseline
 * (max of entry vol and peak-observed vol). Fires a defensive full exit (`VOL_COLLAPSE`) once
 * volume has dropped >= `volWatchCollapsePct` from baseline AND stayed collapsed for
 * >= `volWatchSustainHours` — a debounced "nothing left to trade here, rotate capital" signal.
 *
 * Backtest (60d, 2819 dip-buy entries) — sustained collapse predicts ~-10..-12% forward decline
 * and ~2x capital efficiency vs holding. Default OFF/shadow pending owner-approved thresholds.
 */
import { sql } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { DexSource, VolWatchVerdict } from '../types.js';

const log = child('vol-watch');

type SnapTable =
  | 'raydium_pair_snapshots'
  | 'meteora_pair_snapshots'
  | 'orca_pair_snapshots'
  | 'moonshot_pair_snapshots'
  | 'pumpswap_pair_snapshots';

const TABLE_BY_SOURCE: Record<DexSource, SnapTable | null> = {
  raydium: 'raydium_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  orca: 'orca_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
  pumpswap: 'pumpswap_pair_snapshots',
  pump: null,
  jupiter: null,
};

export interface LoadVolArgs {
  pairAddress: string;
  source: DexSource;
  cfg: PaperTraderConfig;
}

export interface LoadVolResult {
  /** Rolling 1h traded volume USD, or null when unavailable / stale. */
  volUsd: number | null;
  ageMs: number;
  from: 'snapshot' | 'none';
}

async function selectLatestVolume1h(
  table: SnapTable,
  pairAddress: string,
): Promise<{ volume_1h: unknown; ts: Date } | undefined> {
  switch (table) {
    case 'raydium_pair_snapshots': {
      const rows = await sql<{ volume_1h: unknown; ts: Date }[]>`
        SELECT volume_1h, ts FROM raydium_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'meteora_pair_snapshots': {
      const rows = await sql<{ volume_1h: unknown; ts: Date }[]>`
        SELECT volume_1h, ts FROM meteora_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'orca_pair_snapshots': {
      const rows = await sql<{ volume_1h: unknown; ts: Date }[]>`
        SELECT volume_1h, ts FROM orca_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'moonshot_pair_snapshots': {
      const rows = await sql<{ volume_1h: unknown; ts: Date }[]>`
        SELECT volume_1h, ts FROM moonshot_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'pumpswap_pair_snapshots': {
      const rows = await sql<{ volume_1h: unknown; ts: Date }[]>`
        SELECT volume_1h, ts FROM pumpswap_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    default:
      return undefined;
  }
}

/** Latest rolling 1h volume USD for a pair from PG pair snapshots (freshness-gated). */
export async function loadCurrentVol1hUsd(args: LoadVolArgs): Promise<LoadVolResult> {
  const { pairAddress, source, cfg } = args;
  const ts = Date.now();
  const table = TABLE_BY_SOURCE[source];
  if (!table) return { volUsd: null, ageMs: 0, from: 'none' };
  try {
    const row = await selectLatestVolume1h(table, pairAddress);
    if (!row) return { volUsd: null, ageMs: 0, from: 'none' };
    const ageMs = Math.max(0, ts - new Date(row.ts).getTime());
    if (ageMs > cfg.volWatchSnapshotMaxAgeMs) {
      return { volUsd: null, ageMs, from: 'none' };
    }
    const volUsd = row.volume_1h != null ? Number(row.volume_1h) : null;
    if (!(volUsd != null && Number.isFinite(volUsd) && volUsd >= 0)) {
      return { volUsd: null, ageMs, from: 'snapshot' };
    }
    return { volUsd, ageMs, from: 'snapshot' };
  } catch (e) {
    log.warn({ err: (e as Error)?.message, pairAddress }, 'vol-watch snapshot read failed');
    return { volUsd: null, ageMs: 0, from: 'none' };
  }
}

/** High-water baseline: never lower than prior baseline; seed from entry vol when unset. */
export function refreshVolBaseline(
  baselineUsd: number | null | undefined,
  currentVolUsd: number | null | undefined,
): number | null {
  const base = baselineUsd != null && baselineUsd > 0 ? baselineUsd : null;
  const cur = currentVolUsd != null && currentVolUsd > 0 ? currentVolUsd : null;
  if (base == null) return cur;
  if (cur == null) return base;
  return Math.max(base, cur);
}

export interface EvaluateVolArgs {
  cfg: PaperTraderConfig;
  /** High-water baseline volume USD (see {@link refreshVolBaseline}). */
  baselineUsd: number | null;
  /** Current rolling 1h volume USD, or null when unavailable this tick. */
  currentVolUsd: number | null;
  /** Streak anchor from prior tick (epoch ms), or null when not collapsed. */
  collapseSinceTs: number | null;
  positionAgeMs: number;
  /** Injectable clock for tests. */
  nowTs?: number;
}

/**
 * Pure verdict — no I/O. `collapseSinceTs` in the return must be written back onto the OpenTrade
 * so the sustained-collapse streak persists across ticks (analogous to liq-watch consecutiveFailures).
 */
export function evaluateVolCollapseState(args: EvaluateVolArgs): VolWatchVerdict {
  const { cfg, baselineUsd, currentVolUsd, collapseSinceTs, positionAgeMs } = args;
  const ts = args.nowTs ?? Date.now();

  if (!cfg.volWatchEnabled) {
    return { kind: 'skipped', reason: 'feature-disabled', collapseSinceTs, ts };
  }
  if (positionAgeMs < cfg.volWatchMinAgeMin * 60 * 1000) {
    return { kind: 'skipped', reason: 'pre-min-age', collapseSinceTs, ts };
  }
  // No fresh volume this tick — hold streak, do not advance or reset.
  if (currentVolUsd == null || !Number.isFinite(currentVolUsd)) {
    return {
      kind: 'pending',
      currentVolUsd: null,
      baselineUsd: baselineUsd ?? null,
      dropPct: null,
      collapseSinceTs,
      sustainedMs: collapseSinceTs != null ? Math.max(0, ts - collapseSinceTs) : null,
      ts,
    };
  }
  if (!(baselineUsd != null && baselineUsd >= cfg.volWatchMinBaselineUsd)) {
    // Baseline is noise-level — no meaningful collapse signal; clear any streak.
    return { kind: 'skipped', reason: 'baseline-too-small', collapseSinceTs: null, ts };
  }

  const dropPct = +(((baselineUsd - currentVolUsd) / baselineUsd) * 100).toFixed(3);
  if (dropPct < cfg.volWatchCollapsePct) {
    return { kind: 'ok', currentVolUsd, baselineUsd, dropPct, collapseSinceTs: null, ts };
  }

  // Collapsed this tick — anchor the streak and check sustain window.
  const since = collapseSinceTs ?? ts;
  const sustainedMs = Math.max(0, ts - since);
  if (sustainedMs >= cfg.volWatchSustainHours * 3_600_000) {
    return {
      kind: 'force-close',
      reason: 'VOL_COLLAPSE',
      currentVolUsd,
      baselineUsd,
      dropPct,
      collapseSinceTs: since,
      sustainedMs,
      ts,
    };
  }
  return {
    kind: 'pending',
    currentVolUsd,
    baselineUsd,
    dropPct,
    collapseSinceTs: since,
    sustainedMs,
    ts,
  };
}
