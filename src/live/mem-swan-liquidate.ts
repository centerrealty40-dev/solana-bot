/**
 * Live Oscar — black-swan liquidation sweep (driven by `mem-swan.ts`).
 *
 * While a confirmed swan is active (top volume runners dumping; fresh data) and open
 * positions remain, either journals which open positions it *would* liquidate (`shadow`) or
 * force-closes them on-chain (`liquidate`). Retries every tracker tick until flat or calm.
 *
 * Takes a `forceExitLive` closure (bound to `trackerForceFullExitLive`) to avoid a circular
 * import with the tracker. Price per mint is resolved from the latest snapshot (fallback
 * Jupiter). No sell is attempted without a positive market price.
 */
import { fetchJupiterTokenUsdPrice, fetchLatestSnapshotPrice } from '../papertrader/pricing.js';
import type { OpenTrade } from '../papertrader/types.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import {
  consumeMemSwanRisingEdge,
  memSwanHasPendingRise,
  memSwanLiquidationDue,
  memSwanSnapshot,
  resolveMemSwanStatus,
} from './mem-swan.js';

const log = child('live-mem-swan-liq');

/** Resolve USD per token (spot). Snapshot first, Jupiter fallback. */
async function resolveSpotUsdPerToken(
  mint: string,
  source?: 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap',
): Promise<number | null> {
  const snap = await fetchLatestSnapshotPrice(mint, source);
  if (snap != null && snap > 0 && Number.isFinite(snap)) return snap;
  return fetchJupiterTokenUsdPrice(mint);
}

export interface MemSwanSweepArgs {
  liveCfg?: LiveOscarConfig | null;
  open: Map<string, OpenTrade>;
  /** Force full on-chain exit of one open position (bound to trackerForceFullExitLive). */
  forceExitLive: (openKey: string, marketSell: number) => Promise<boolean>;
}

/**
 * Run the swan sweep for this tick. No-op unless swan is active, data is fresh, and open
 * positions remain. Safe to call from the top of every tracker tick (retries while swan
 * persists after a failed liquidate).
 */
export async function runMemSwanLiquidationSweep(args: MemSwanSweepArgs): Promise<void> {
  const { liveCfg, open } = args;
  if (!liveCfg || liveCfg.executionMode !== 'live') return;
  if (!liveCfg.liveMemSwanEnabled || liveCfg.liveMemSwanMode === 'off') return;

  // Ensures the background refresher is running.
  const status = resolveMemSwanStatus(liveCfg);
  if (status.kind === 'disabled' || status.kind === 'unknown') return;
  if (!memSwanLiquidationDue(liveCfg)) return;

  const entries = [...open.entries()].filter(([, ot]) => ot.mint !== WRAPPED_SOL_MINT);
  if (entries.length === 0) return;

  const risingEdge = memSwanHasPendingRise();
  if (risingEdge) consumeMemSwanRisingEdge(liveCfg);
  const sweepKind = risingEdge ? 'rising_edge' : 'retry';

  const snap = memSwanSnapshot();
  const metricDetail = {
    ewReturnPct: snap.metrics?.ewReturnPct ?? null,
    medReturnPct: snap.metrics?.medReturnPct ?? null,
    breadthRedPct: snap.metrics?.breadthRedPct ?? null,
    runnerCount: snap.metrics?.runnerCount ?? null,
    ewDropThresholdPct: liveCfg.liveMemSwanEwDropPct,
    topN: liveCfg.liveMemSwanTopN,
    rollMin: liveCfg.liveMemSwanRollMin,
  };

  const openMints = entries.map(([, ot]) => ot.symbol || ot.mint.slice(0, 8));

  if (liveCfg.liveMemSwanMode === 'shadow') {
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason: 'mem_swan_would_liquidate',
      detail: { ...metricDetail, openCount: entries.length, openMints, sweepKind },
    });
    log.warn(
      { ...metricDetail, openCount: entries.length },
      'mem-swan SHADOW: would liquidate all open positions (no sell)',
    );
    return;
  }

  // mode === 'liquidate'
  appendLiveJsonlEvent({
    kind: 'risk_block',
    limit: risingEdge ? 'mem_swan_liquidate' : 'mem_swan_liquidate_retry',
    detail: { ...metricDetail, openCount: entries.length, openMints, sweepKind },
  });
  log.warn({ ...metricDetail, openCount: entries.length }, 'mem-swan LIQUIDATE: closing all open positions');

  let liquidated = 0;
  let failed = 0;
  let noPrice = 0;
  for (const [openKey, ot] of entries) {
    if (ot.mint === WRAPPED_SOL_MINT) continue;
    const spot = await resolveSpotUsdPerToken(
      ot.mint,
      ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
    );
    if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) {
      noPrice++;
      continue;
    }
    try {
      const ok = await args.forceExitLive(openKey, spot);
      if (ok) liquidated++;
      else failed++;
    } catch (e) {
      failed++;
      log.warn({ mint: ot.mint.slice(0, 8), err: String((e as Error)?.message ?? e) }, 'mem-swan liquidate sell failed');
    }
    const delay = liveCfg.liveTrackerInterMintDelayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  appendLiveJsonlEvent({
    kind: 'risk_note',
    reason: 'mem_swan_liquidate_done',
    detail: { ...metricDetail, attempted: entries.length, liquidated, failed, noPrice, sweepKind },
  });
  log.warn({ attempted: entries.length, liquidated, failed, noPrice }, 'mem-swan LIQUIDATE done');
}
