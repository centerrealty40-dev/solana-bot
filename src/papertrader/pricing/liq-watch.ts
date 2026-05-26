/**
 * W7.5 - Liquidity drain watch (see repo spec W7.5).
 */
import { qnCall } from '../../core/rpc/qn-client.js';
import { sql } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { DexSource, LiqWatchVerdict, OpenTrade } from '../types.js';

const log = child('liq-watch');

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

export interface LoadLiqArgs {
  pairAddress: string;
  source: DexSource;
  cfg: PaperTraderConfig;
}

export interface LoadLiqResult {
  liqUsd: number | null;
  ageMs: number;
  from: 'snapshot' | 'rpc' | 'none';
}

async function selectLatestLiquidity(
  table: SnapTable,
  pairAddress: string,
): Promise<{ liquidity_usd: unknown; ts: Date } | undefined> {
  switch (table) {
    case 'raydium_pair_snapshots': {
      const rows = await sql<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM raydium_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'meteora_pair_snapshots': {
      const rows = await sql<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM meteora_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'orca_pair_snapshots': {
      const rows = await sql<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM orca_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'moonshot_pair_snapshots': {
      const rows = await sql<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM moonshot_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    case 'pumpswap_pair_snapshots': {
      const rows = await sql<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM pumpswap_pair_snapshots
        WHERE pair_address = ${pairAddress}
        ORDER BY ts DESC LIMIT 1
      `;
      return rows[0];
    }
    default:
      return undefined;
  }
}

export async function loadCurrentPoolLiqUsd(args: LoadLiqArgs): Promise<LoadLiqResult> {
  const { pairAddress, source, cfg } = args;
  const ts = Date.now();
  const table = TABLE_BY_SOURCE[source];
  if (!table) return { liqUsd: null, ageMs: 0, from: 'none' };
  try {
    const row = await selectLatestLiquidity(table, pairAddress);
    if (!row) {
      return await maybeRpcFallback(args, ts);
    }
    const liqUsd = row.liquidity_usd != null ? Number(row.liquidity_usd) : null;
    const ageMs = Math.max(0, ts - new Date(row.ts).getTime());
    if (ageMs > cfg.liqWatchSnapshotMaxAgeMs) {
      const rpc = await maybeRpcFallback(args, ts);
      if (rpc.from === 'rpc' && rpc.liqUsd != null) return rpc;
      return { liqUsd: null, ageMs, from: 'none' };
    }
    if (!(liqUsd != null && liqUsd > 0)) {
      return { liqUsd: null, ageMs, from: 'snapshot' };
    }
    return { liqUsd, ageMs, from: 'snapshot' };
  } catch (e) {
    log.warn({ err: (e as Error)?.message, pairAddress }, 'liq-watch snapshot read failed');
    return { liqUsd: null, ageMs: 0, from: 'none' };
  }
}

async function maybeRpcFallback(args: LoadLiqArgs, ts: number): Promise<LoadLiqResult> {
  const { cfg } = args;
  if (!cfg.liqWatchRpcFallback) {
    return { liqUsd: null, ageMs: 0, from: 'none' };
  }
  void qnCall;
  void ts;
  log.debug({ msg: 'rpc fallback pending W7.5.1 (vault addresses not stamped)' });
  return { liqUsd: null, ageMs: 0, from: 'none' };
}

export interface EvaluateArgs {
  cfg: PaperTraderConfig;
  entryLiqUsd: number;
  load: LoadLiqResult;
  consecutiveFailures: number;
  positionAgeMs: number;
}

export function evaluateLiqDrainState(args: EvaluateArgs): LiqWatchVerdict {
  const { cfg, entryLiqUsd, load, consecutiveFailures, positionAgeMs } = args;
  const ts = Date.now();
  if (positionAgeMs < cfg.liqWatchMinAgeMin * 60 * 1000) {
    return { kind: 'skipped', reason: 'pre-min-age', ts };
  }
  if (load.from === 'none' || load.liqUsd == null) {
    return { kind: 'pending', currentLiqUsd: null, consecutiveFailures, ageMs: null, ts };
  }
  if (!(entryLiqUsd > 0)) {
    return { kind: 'skipped', reason: 'no-entry-liq', ts };
  }
  const dropPct = +(((entryLiqUsd - load.liqUsd) / entryLiqUsd) * 100).toFixed(3);
  if (dropPct < cfg.liqWatchDrainPct) {
    return {
      kind: 'ok',
      currentLiqUsd: load.liqUsd,
      dropPct,
      ageMs: load.ageMs,
      from: load.from as 'snapshot' | 'rpc',
      ts,
    };
  }
  const next = consecutiveFailures + 1;
  if (next < cfg.liqWatchConsecutiveFailures) {
    return {
      kind: 'pending',
      currentLiqUsd: load.liqUsd,
      consecutiveFailures: next,
      ageMs: load.ageMs,
      ts,
    };
  }
  return {
    kind: 'force-close',
    reason: 'LIQ_DRAIN',
    currentLiqUsd: load.liqUsd,
    dropPct,
    ageMs: load.ageMs,
    from: load.from as 'snapshot' | 'rpc',
    ts,
  };
}

export async function buildOptionalLiqWatchCloseStamp(
  cfg: PaperTraderConfig,
  ot: OpenTrade,
): Promise<Record<string, unknown> | undefined> {
  if (!cfg.liqWatchStampOnAllClose) return undefined;
  if (!ot.pairAddress || !(ot.entryLiqUsd && ot.entryLiqUsd > 0)) return undefined;
  const src = (ot.source ?? 'raydium') as DexSource;
  const load = await loadCurrentPoolLiqUsd({
    pairAddress: ot.pairAddress,
    source: src,
    cfg,
  });
  const ts = Date.now();
  if (load.liqUsd == null || load.from === 'none') {
    return {
      source: load.from,
      entryLiqUsd: ot.entryLiqUsd,
      currentLiqUsd: null,
      dropPct: null,
      ageMs: load.ageMs,
      consecutiveFailures: ot.liqWatchConsecutiveFailures ?? 0,
      ts,
    };
  }
  const dropPct = +(((ot.entryLiqUsd - load.liqUsd) / ot.entryLiqUsd) * 100).toFixed(3);
  return {
    source: load.from,
    entryLiqUsd: ot.entryLiqUsd,
    currentLiqUsd: load.liqUsd,
    dropPct,
    ageMs: load.ageMs,
    consecutiveFailures: ot.liqWatchConsecutiveFailures ?? 0,
    ts,
  };
}

/** Test seam — vitest only (shared DB client has no pool to tear down here). */
export function _liqWatchInternalForTests(): { reset(): void } {
  return { reset(): void {} };
}