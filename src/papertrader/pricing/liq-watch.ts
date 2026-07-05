/**
 * W7.5 - Liquidity drain watch (see repo spec W7.5).
 */
import { qnCall } from '../../core/rpc/qn-client.js';
import { sql } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { DexSource, LiqWatchVerdict, OpenTrade, SnapshotCandidateRow } from '../types.js';
import { resolveDiscoveryMarketQuote, type DiscoveryQuoteSource } from './discovery-market-quote.js';

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
  from: 'snapshot' | 'rpc' | 'discovery' | 'none';
  /** Raw PG pair snapshot liquidity (before discovery override). */
  pgLiqUsd?: number | null;
  /** Birdeye/DexScreener reference liquidity when discovery quote resolved. */
  referenceLiqUsd?: number | null;
  referenceSource?: DiscoveryQuoteSource;
}

export interface LoadLiqWatchArgs extends LoadLiqArgs {
  mint: string;
  symbol?: string;
}

/** Relative disagreement between two positive USD liquidity readings (0–100). */
export function liqSourceDisagreementPct(aUsd: number, bUsd: number): number {
  if (!(aUsd > 0 && bUsd > 0)) return 0;
  const base = Math.max(aUsd, bUsd);
  return +((Math.abs(aUsd - bUsd) / base) * 100).toFixed(3);
}

/** Refresh entry baseline after DCA — never lower than prior entry liq. */
export function refreshEntryLiqBaseline(
  entryLiqUsd: number | null | undefined,
  currentLiqUsd: number | null | undefined,
): number | null {
  const entry = entryLiqUsd != null && entryLiqUsd > 0 ? entryLiqUsd : null;
  const current = currentLiqUsd != null && currentLiqUsd > 0 ? currentLiqUsd : null;
  if (entry == null) return current;
  if (current == null) return entry;
  return Math.max(entry, current);
}

/** After DCA leg — bump entryLiqUsd to max(entry, current discovery/pool liq). */
export async function refreshOpenTradeEntryLiqAfterDca(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
): Promise<void> {
  if (!ot.pairAddress) return;
  const load = await loadLiqWatchLiqUsd({
    mint: ot.mint,
    symbol: ot.symbol,
    pairAddress: ot.pairAddress,
    source: (ot.source ?? 'raydium') as DexSource,
    cfg,
  });
  const next = refreshEntryLiqBaseline(ot.entryLiqUsd, load.liqUsd);
  if (next != null && next > 0 && next !== ot.entryLiqUsd) {
    ot.entryLiqUsd = next;
  }
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
    return { liqUsd, ageMs, from: 'snapshot', pgLiqUsd: liqUsd };
  } catch (e) {
    log.warn({ err: (e as Error)?.message, pairAddress }, 'liq-watch snapshot read failed');
    return { liqUsd: null, ageMs: 0, from: 'none' };
  }
}

/**
 * PG pair snapshot + optional Birdeye/DexScreener discovery quote (same resolver as entry eval).
 * Prefers fresh external liquidity over raw PG-only reading to avoid stale-pool false LIQ_DRAIN.
 */
export async function loadLiqWatchLiqUsd(args: LoadLiqWatchArgs): Promise<LoadLiqResult> {
  const pgLoad = await loadCurrentPoolLiqUsd(args);
  const useDiscovery =
    args.cfg.liqWatchDiscoveryQuote || args.cfg.birdeyePrimaryEnabled;
  if (!useDiscovery || !args.mint) {
    return pgLoad;
  }

  const pgLiqUsd = pgLoad.pgLiqUsd ?? pgLoad.liqUsd;
  const pgRow: SnapshotCandidateRow = {
    mint: args.mint,
    symbol: args.symbol ?? args.mint.slice(0, 8),
    ts: new Date(Math.max(0, Date.now() - (pgLoad.ageMs ?? 0))),
    launch_ts: null,
    age_min: null,
    price_usd: 0,
    liquidity_usd: pgLiqUsd != null && pgLiqUsd > 0 ? pgLiqUsd : 0,
    volume_5m: 0,
    volume_1h: 0,
    buys_5m: 0,
    sells_5m: 0,
    market_cap_usd: null,
    source: args.source,
    holder_count: 0,
    token_age_min: 0,
    pair_address: args.pairAddress,
  };

  try {
    const quote = await resolveDiscoveryMarketQuote({
      enabled: true,
      mint: args.mint,
      pgRow,
      birdeyeTtlMs: args.cfg.birdeyeMarketTtlMs,
      birdeyeMaxStaleMs: args.cfg.birdeyeMaxStaleMs,
      coverageGapMinMs: args.cfg.birdeyeCoverageGapMinMs,
    });

    const referenceLiqUsd = quote.liquidityUsd;
    const referenceSource = quote.source;

    if (
      referenceLiqUsd != null &&
      referenceLiqUsd > 0 &&
      referenceSource !== 'pg_snapshot'
    ) {
      return {
        liqUsd: referenceLiqUsd,
        ageMs: pgLoad.ageMs,
        from: 'discovery',
        pgLiqUsd,
        referenceLiqUsd,
        referenceSource,
      };
    }

    return {
      ...pgLoad,
      pgLiqUsd,
      referenceLiqUsd: referenceLiqUsd ?? null,
      referenceSource,
    };
  } catch (e) {
    log.warn({ err: (e as Error)?.message, mint: args.mint.slice(0, 8) }, 'liq-watch discovery quote failed');
    return pgLoad;
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

function liqWatchFromTag(load: LoadLiqResult): 'snapshot' | 'rpc' {
  return load.from === 'rpc' ? 'rpc' : 'snapshot';
}

/** Block force-close when PG snapshot and discovery reference disagree beyond configured threshold. */
export function shouldBlockLiqDrainOnDisagreement(args: {
  cfg: PaperTraderConfig;
  entryLiqUsd: number;
  load: LoadLiqResult;
  dropPct: number;
}): { block: boolean; disagreementPct: number; referenceLiqUsd?: number; pgLiqUsd?: number } {
  const { cfg, load, dropPct } = args;
  const pgLiqUsd = load.pgLiqUsd ?? (load.from === 'snapshot' ? load.liqUsd : null);
  const referenceLiqUsd = load.referenceLiqUsd ?? null;
  if (!(pgLiqUsd != null && pgLiqUsd > 0 && referenceLiqUsd != null && referenceLiqUsd > 0)) {
    return { block: false, disagreementPct: 0 };
  }
  const disagreementPct = liqSourceDisagreementPct(pgLiqUsd, referenceLiqUsd);
  if (disagreementPct <= cfg.liqWatchDisagreementPct) {
    return { block: false, disagreementPct, referenceLiqUsd, pgLiqUsd };
  }
  if (dropPct < cfg.liqWatchDrainPct) {
    return { block: false, disagreementPct, referenceLiqUsd, pgLiqUsd };
  }
  return { block: true, disagreementPct, referenceLiqUsd, pgLiqUsd };
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
      from: liqWatchFromTag(load),
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

  const disagree = shouldBlockLiqDrainOnDisagreement({ cfg, entryLiqUsd, load, dropPct });
  if (disagree.block) {
    return {
      kind: 'skipped',
      reason: 'liq-disagreement',
      ts,
      pgLiqUsd: disagree.pgLiqUsd,
      referenceLiqUsd: disagree.referenceLiqUsd,
      disagreementPct: disagree.disagreementPct,
    };
  }

  return {
    kind: 'force-close',
    reason: 'LIQ_DRAIN',
    currentLiqUsd: load.liqUsd,
    dropPct,
    ageMs: load.ageMs,
    from: liqWatchFromTag(load),
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
  const load = await loadLiqWatchLiqUsd({
    mint: ot.mint,
    symbol: ot.symbol,
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
    pgLiqUsd: load.pgLiqUsd ?? null,
    referenceLiqUsd: load.referenceLiqUsd ?? null,
    referenceSource: load.referenceSource ?? null,
    ts,
  };
}

/** Test seam — vitest only (shared DB client has no pool to tear down here). */
export function _liqWatchInternalForTests(): { reset(): void } {
  return { reset(): void {} };
}
