/**
 * Thin integration hook for tracker.ts — keeps UPE logic out of the 6k-line monolith.
 */
import type { LiveOscarConfig } from '../config.js';
import type { OpenTrade, ExitReason, PartialSell } from '../../papertrader/types.js';
import { child } from '../../core/logger.js';
import {
  evaluateExitIntent,
  createFullExitIntent,
  createPartialExitIntent,
  partialReasonToGuardExitReason,
} from './exit-intent.js';
import { loadPositionEngineConfigFromEnv } from './config.js';
import { snapshotFromOpenTrade } from './adapter.js';
import { computeClosePnl } from './ledger.js';
import { syncUpeOnTrackerTick } from './orchestrator.js';
import { onEntryLegConfirmed } from './entry-policy.js';
import type { ChainSnapshot } from './types.js';

const log = child('upe');

export type UpeExitBlockResult =
  | { blocked: false }
  | {
      blocked: true;
      invariant: 'UPE-I1' | 'UPE-I2' | 'UPE-I5';
      reason: string;
      phase: string;
    };

function chainFromTrackerArgs(args: {
  ot: OpenTrade;
  mint: string;
  chainMap: Map<string, bigint> | null | undefined;
  chainOscarUsd: number;
  priceUsd: number;
}): ChainSnapshot {
  const dec = args.ot.tokenDecimals ?? 6;
  const raw = args.chainMap?.get(args.mint) ?? 0n;
  return {
    rawTokenBalance: raw,
    decimals: dec,
    priceUsd: args.priceUsd,
    oscarAttributedUsd: args.chainOscarUsd,
  };
}

function upeLiveEnabled(liveOscarCfg: LiveOscarConfig | undefined): boolean {
  return (
    liveOscarCfg?.strategyEnabled === true &&
    liveOscarCfg.executionMode === 'live' &&
    loadPositionEngineConfigFromEnv().enabled
  );
}

/** Sync UPE phase each tracker tick (Phase B orchestrator). */
export function syncLiveUpeOnTrackerTick(args: {
  ot: OpenTrade;
  mint: string;
  chainMap: Map<string, bigint> | null | undefined;
  chainOscarUsd: number;
  priceUsd: number;
  liveOscarCfg: LiveOscarConfig | undefined;
}): void {
  if (!upeLiveEnabled(args.liveOscarCfg)) return;
  const chain = chainFromTrackerArgs(args);
  syncUpeOnTrackerTick({ ot: args.ot, chain });
}

/** After confirmed entry leg buy (Phase B). */
export function notifyUpeEntryLegConfirmed(args: {
  ot: OpenTrade;
  liveExecution?: boolean;
}): void {
  if (!args.liveExecution || !loadPositionEngineConfigFromEnv().enabled) return;
  onEntryLegConfirmed(args.ot);
}

/** Returns block info when unified position engine forbids full exit. */
export function tryBlockLiveExitViaUpe(args: {
  ot: OpenTrade;
  mint: string;
  exitReason: ExitReason;
  chainMap: Map<string, bigint> | null | undefined;
  chainOscarUsd: number;
  priceUsd: number;
  liveOscarCfg: LiveOscarConfig | undefined;
  exitInFlight?: boolean;
  emergency?: boolean;
}): UpeExitBlockResult {
  if (!upeLiveEnabled(args.liveOscarCfg)) return { blocked: false };

  const cfg = loadPositionEngineConfigFromEnv();
  const chain = chainFromTrackerArgs(args);
  const snap = snapshotFromOpenTrade({
    ot: args.ot,
    chain,
    exitInFlight: args.exitInFlight ?? args.ot.liveUpeExitInFlight === true,
  });
  const decision = evaluateExitIntent(
    snap,
    cfg,
    createFullExitIntent({ reason: args.exitReason, emergency: args.emergency }),
  );
  if (decision.allowed) return { blocked: false };
  return {
    blocked: true,
    invariant: decision.invariant,
    reason: decision.reason,
    phase: decision.phase,
  };
}

/** Block partial sell during entry-split / desync (Phase C). */
export function tryBlockPartialSellViaUpe(args: {
  ot: OpenTrade;
  mint: string;
  partialReason: PartialSell['reason'];
  chainMap: Map<string, bigint> | null | undefined;
  chainOscarUsd: number;
  priceUsd: number;
  liveOscarCfg: LiveOscarConfig | undefined;
  sellFraction: number;
}): UpeExitBlockResult {
  if (!upeLiveEnabled(args.liveOscarCfg)) return { blocked: false };

  const cfg = loadPositionEngineConfigFromEnv();
  const chain = chainFromTrackerArgs(args);
  const snap = snapshotFromOpenTrade({
    ot: args.ot,
    chain,
    exitInFlight: args.ot.liveUpeExitInFlight === true,
  });
  const decision = evaluateExitIntent(
    snap,
    cfg,
    createPartialExitIntent({
      reason: args.partialReason,
      sellFraction: args.sellFraction,
    }),
  );
  if (decision.allowed) return { blocked: false };
  return {
    blocked: true,
    invariant: decision.invariant,
    reason: decision.reason,
    phase: decision.phase,
  };
}

export function logUpeExitBlock(args: {
  mint: string;
  symbol: string;
  exitReason: string;
  block: Extract<UpeExitBlockResult, { blocked: true }>;
}): void {
  log.warn(
    {
      mint: args.mint.slice(0, 8),
      symbol: args.symbol,
      exitReason: args.exitReason,
      invariant: args.block.invariant,
      phase: args.block.phase,
      detail: args.block.reason,
    },
    'live tracker: unified position engine blocked exit',
  );
}

export function logUpePartialBlock(args: {
  mint: string;
  symbol: string;
  partialReason: PartialSell['reason'];
  block: Extract<UpeExitBlockResult, { blocked: true }>;
}): void {
  log.warn(
    {
      mint: args.mint.slice(0, 8),
      symbol: args.symbol,
      partialReason: args.partialReason,
      guardReason: partialReasonToGuardExitReason(args.partialReason),
      invariant: args.block.invariant,
      phase: args.block.phase,
      detail: args.block.reason,
    },
    'live tracker: unified position engine blocked partial sell',
  );
}

/** Apply desync-safe close PnL when UPE enabled (live full close). */
export function applyUpeClosePnlIfEnabled(args: {
  liveOscarCfg: LiveOscarConfig | undefined;
  ot: OpenTrade;
  chainOscarUsd: number;
  priceUsd: number;
  finalProceedsUsd: number;
  partialProceedsUsd: number;
}): {
  applied: boolean;
  netPnlUsd: number;
  netPnlPct: number;
  totalProceedsUsd: number;
  desyncAdjusted: boolean;
} | null {
  if (!upeLiveEnabled(args.liveOscarCfg)) return null;

  const chain: ChainSnapshot = {
    rawTokenBalance: 0n,
    decimals: args.ot.tokenDecimals ?? 6,
    priceUsd: args.priceUsd,
    oscarAttributedUsd: args.chainOscarUsd,
  };
  const snap = snapshotFromOpenTrade({ ot: args.ot, chain });
  const pnl = computeClosePnl({
    confirmedBuys: snap.confirmedBuys,
    confirmedSells: snap.confirmedSells,
    journalInvestedUsd: args.ot.totalInvestedUsd,
    chain,
    finalProceedsUsd: args.finalProceedsUsd,
  });

  return {
    applied: true,
    netPnlUsd: pnl.netPnlUsd,
    netPnlPct: pnl.netPnlPct,
    totalProceedsUsd: pnl.totalProceedsUsd,
    desyncAdjusted: pnl.desyncAdjusted,
  };
}
