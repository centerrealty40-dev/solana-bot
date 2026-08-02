import type { TxJsonParsed } from '../parser/rpc-http.js';
import { decodeAllowlistedDexSwapForWallet } from '../parser/allowlisted-dex-swap.js';
import { decodePumpfunSwap, PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { SwapInsert } from '../parser/pumpfun.js';
import type { CopyTraderConfig } from './config.js';
import { fetchDexInfo } from './dex-info.js';
import { evaluateCopyAdd, evaluateCopyEntry, evaluateCopyEntryDip } from './evaluate.js';
import {
  isEntryFullyDeployed,
  entryTargetDeployUsd,
  resolveEntryDeployedCostUsd,
  shouldAbandonEntryDipOnLeaderSell,
} from './entry-deploy.js';
import {
  bumpEntryDipPassStreak,
  entryDipConfirmReason,
  resetEntryDipPassStreak,
  resolveEntryDipEvalPrice,
  type EntryDipQuoteCache,
} from './entry-dip-gate.js';
import {
  entryDipSizeUsd,
  entryProbeSizeUsd,
  entryScheduleDelayMs,
  entryTargetUsd,
  isEntryProbePending,
  syncEntryPendingSizing,
  usesDipOnlyEntry,
  usesSplitEntryProbe,
} from './entry-probe.js';
import { shouldIgnoreMissedEntryLeaderRebuy } from './entry-late.js';
import { appendCopyEvent, executeCopyBuy, executeCopySell } from './executor.js';
import {
  applyLeaderSwapToLedger,
  bootstrapLeaderPreSellBalance,
  leaderPreBalanceRaw,
} from './leader-ledger.js';
import { scheduleLeaderFlatTailSweeps } from './leader-flat-tail-sweep.js';
import { resolveOurSellFraction } from './leader-dust.js';
import {
  absRawAmount,
  leaderAddFraction,
  leaderSellFraction,
  ourAddUsdFromLeaderAdd,
} from './proportional.js';
import { fetchParsedTransaction, fetchWalletMintBalanceRaw, fetchWalletSignatures, type SignatureRow } from './rpc.js';
import {
  cancelPendingBuysForMint,
  findPendingBuy,
  isPendingBuyExpired,
  leaderHoldingsShrunkSinceSignal,
  removePendingBuyById,
  shouldLogBuyDefer,
  computeRetryUntilTs,
} from './pending-buy-retry.js';
import {
  findPendingSell,
  isPendingSellExpired,
  isSellRetryableError,
  removePendingSellById,
  shouldLogSellDefer,
} from './pending-sell-retry.js';
import {
  canScheduleProportionalAdd,
  gcSeenSignatures,
  hasPendingBuyForMint,
  newId,
  openPositionsCount,
  positionRoomUsd,
  readCopyTraderState,
  writeCopyTraderState,
  COPY_LEADER_POSITION_SOURCE,
  type CopyPosition,
  type CopyTraderState,
  type PendingBuy,
  type PendingSell,
} from './state.js';
import { fmtCopyAlert, notifyCopyTraderTelegram } from './telegram.js';
import { fetchJupiterTokenUsdPrice, getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';
import { isUsdPriceOutlierVsAnchor } from '../papertrader/pricing/dexscreener-pair-pick.js';
import {
  closePositionForMint,
  ensurePositionFromWallet,
  fetchExecutionWalletBalanceRaw,
  reconcileGhostPositions,
  reconcileOscarHandoffClosedFromDisk,
  refreshPositionFromWallet,
  syncPositionFromWallet,
  walletNotionalUsdFromRaw,
  accumulateCopyTokenRaw,
  copySellableTokenRaw,
  copyTrackedTokenRaw,
} from './position-reconcile.js';
import {
  checkCopyBuyWalletCapGuard,
  purgeStaleOscarHandoffPosition,
  shouldIgnoreLeaderForMint,
  type CopyBuyOscarDupGuardVerdict,
  type CopyLeaderIgnoreVerdict,
} from './oscar-position-guard.js';
import { checkCopySpareCapitalGate } from './spare-capital-gate.js';
import { checkCopyFundingGate } from './funding-gate.js';
import { usesOscarExitPolicy, usesTrailingExitPolicy } from './exit-mode.js';
import { fetchCopyEntryContext, type CopyEntryContext } from './entry-context.js';
import { evaluateLeaderMarketGate, evaluateLeaderPriorGate } from './entry-gates.js';
import {
  applyLeaderSwapToHistory,
  gcLeaderHistory,
  leaderMintStats,
  type LeaderMintStats,
} from './leader-history.js';
import { processTrailingExits, type TrailExitEvent } from './trail-exit.js';
import { handoffCopyPositionToOscarExit } from './copy-oscar-exit-handoff.js';
import {
  copyPositionOscarExitManaged,
  reconcileIneligibleOscarHandoffs,
} from './copy-oscar-handoff-eligibility.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function logCopyLeaderIgnored(
  cfg: CopyTraderConfig,
  args: {
    mint: string;
    symbol?: string;
    leaderSignature?: string;
    leaderAction: 'buy' | 'sell' | 'add' | 'pending_buy' | 'pending_sell' | 'tail_sweep';
    verdict: CopyLeaderIgnoreVerdict & { ignore: true };
    oscarPromotedAt?: number;
  },
): void {
  appendCopyEvent(cfg, {
    kind: 'copy_leader_ignored',
    reason: args.verdict.reason,
    mint: args.mint,
    symbol: args.symbol ?? null,
    leaderSignature: args.leaderSignature ?? null,
    leaderAction: args.leaderAction,
    oscarPromotedAt: args.oscarPromotedAt ?? null,
  });
}

function leaderIgnoreBlocksAction(
  cfg: CopyTraderConfig,
  args: {
    mint: string;
    copyPosition?: CopyPosition | null;
    walletMintRaw?: bigint;
  },
): CopyLeaderIgnoreVerdict & { ignore: true } | null {
  const verdict = shouldIgnoreLeaderForMint({
    cfg,
    mint: args.mint,
    copyPosition: args.copyPosition,
    statePath: cfg.statePath,
    walletMintRaw: args.walletMintRaw,
  });
  return verdict.ignore ? verdict : null;
}

function logCopyBuySkipped(
  cfg: CopyTraderConfig,
  args: {
    mint: string;
    symbol?: string;
    leaderSignature?: string;
    buyKind?: 'entry' | 'add';
    verdict: CopyBuyOscarDupGuardVerdict & { skip: true };
  },
): void {
  appendCopyEvent(cfg, {
    kind: 'copy_buy_skipped',
    reason: args.verdict.reason,
    mint: args.mint,
    symbol: args.symbol ?? null,
    leaderSignature: args.leaderSignature ?? null,
    buyKind: args.buyKind ?? null,
    estUsd: args.verdict.estUsd ?? null,
    minUsd: args.verdict.minUsd ?? null,
  });
}

function oscarDupGuardBlocksBuy(
  cfg: CopyTraderConfig,
  args: {
    mint: string;
    walletMintRaw?: bigint;
    priceUsd?: number;
  },
): CopyBuyOscarDupGuardVerdict & { skip: true } | null {
  const verdict = checkCopyBuyWalletCapGuard({
    cfg,
    mint: args.mint,
    walletMintRaw: args.walletMintRaw,
    priceUsd: args.priceUsd,
    statePath: cfg.statePath,
  });
  return verdict.skip ? verdict : null;
}

let lastPollRpcFailLogMs = 0;
const POLL_RPC_FAIL_LOG_MS = 60_000;

type LeaderGateBlock = {
  reasons: string[];
  stats: LeaderMintStats | null;
  ctx: CopyEntryContext | null;
};

/**
 * Selective copy gates. The state-only prior-record check runs first so most
 * candidates are rejected without spending a DexScreener request.
 */
async function leaderGateBlocksEntry(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  mint: string,
): Promise<LeaderGateBlock | null> {
  if (!cfg.leaderGatesEnabled) return null;

  const stats = leaderMintStats(state, mint);
  const prior = evaluateLeaderPriorGate(cfg, stats);
  if (!prior.pass) return { reasons: prior.reasons, stats, ctx: null };

  const ctx = await fetchCopyEntryContext(mint);
  const market = evaluateLeaderMarketGate(cfg, ctx);
  if (!market.pass) return { reasons: market.reasons, stats, ctx };

  return null;
}

function scheduleTrailExitSell(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  event: TrailExitEvent,
): void {
  const now = Date.now();
  const pending: PendingSell = {
    id: newId('ps'),
    mint: event.pos.mint,
    symbol: event.pos.symbol,
    leaderSignature: `trail_exit:${event.reason}`,
    leaderSellTs: now,
    dueTs: now,
    fraction: 1,
    retryUntilTs: computeRetryUntilTs(now, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);

  appendCopyEvent(cfg, {
    kind: 'trail_exit_scheduled',
    reason: event.reason,
    mint: event.pos.mint,
    symbol: event.pos.symbol,
    entryPriceUsd: event.pos.entryPriceUsd,
    priceUsd: event.priceUsd,
    peakPriceUsd: event.peakPriceUsd,
    gainPct: Number(event.gainPct.toFixed(2)),
    heldSec: Math.round(event.heldMs / 1000),
    trailArmPct: cfg.trailArmPct,
    trailGivebackPct: cfg.trailGivebackPct,
  });
}

function randomSellDelayMs(cfg: CopyTraderConfig): number {
  const span = cfg.sellDelayMaxMs - cfg.sellDelayMinMs;
  if (span <= 0) return cfg.sellDelayMinMs;
  return cfg.sellDelayMinMs + Math.floor(Math.random() * (span + 1));
}

function decodeSwapForWallet(tx: TxJsonParsed, wallet: string, solUsd: number): SwapInsert | null {
  const pf = decodePumpfunSwap(tx, PUMP_FUN_PROGRAM_ID, solUsd).find((s) => s.wallet === wallet);
  if (pf) return pf;
  return decodeAllowlistedDexSwapForWallet(tx, wallet, solUsd);
}

/** Max |dex|/|leader| (or inverse) before Dex is treated as garbage (TOKEN/MET ≈ $128 vs fill ≈ $0.028). */
function copyDexVsLeaderMaxRatio(): number {
  const n = Number(process.env.COPY_TRADER_DEX_VS_LEADER_MAX_RATIO ?? '2');
  return Number.isFinite(n) && n > 1 ? n : 2;
}

/**
 * Resolve eval/exec spot: prefer Dex, but reject outliers vs leader fill (or Jupiter).
 * Never leave a pending buy stuck on a single garbage Dex pair forever.
 */
async function resolveCurrentPrice(
  mint: string,
  dexPrice: number,
  leaderPriceUsd = 0,
): Promise<{ priceUsd: number; source: 'dex' | 'jupiter' | 'leader_fill' | 'none'; rejectedDex: boolean }> {
  const maxRatio = copyDexVsLeaderMaxRatio();
  const dexOk =
    dexPrice > 0 &&
    (!(leaderPriceUsd > 0) || !isUsdPriceOutlierVsAnchor(dexPrice, leaderPriceUsd, maxRatio));
  if (dexOk) return { priceUsd: dexPrice, source: 'dex', rejectedDex: false };

  const rejectedDex = dexPrice > 0 && leaderPriceUsd > 0;
  const jup = await fetchJupiterTokenUsdPrice(mint);
  if (
    jup != null &&
    jup > 0 &&
    (!(leaderPriceUsd > 0) || !isUsdPriceOutlierVsAnchor(jup, leaderPriceUsd, maxRatio))
  ) {
    return { priceUsd: jup, source: 'jupiter', rejectedDex };
  }
  if (leaderPriceUsd > 0) {
    return { priceUsd: leaderPriceUsd, source: 'leader_fill', rejectedDex };
  }
  if (dexPrice > 0) return { priceUsd: dexPrice, source: 'dex', rejectedDex: false };
  return { priceUsd: jup ?? 0, source: jup != null && jup > 0 ? 'jupiter' : 'none', rejectedDex };
}

export async function pollLeaderWallet(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const { rows, rpcFailed } = await fetchWalletSignatures(cfg.rpcUrl, cfg.targetWallet, cfg.signatureLimit);
  if (rpcFailed) {
    const now = Date.now();
    if (now - lastPollRpcFailLogMs >= POLL_RPC_FAIL_LOG_MS) {
      lastPollRpcFailLogMs = now;
      console.warn('[copy-trader] poll: getSignaturesForAddress failed (RPC unreachable or error)');
    }
    return;
  }
  if (rows.length === 0) return;

  const latest = rows[0]!.signature;
  const prev = state.lastSignature;
  if (!prev) {
    state.lastSignature = latest;
    for (const row of rows) state.seenSignatures[row.signature] = Date.now();
    return;
  }

  const newRows: SignatureRow[] = [];
  for (const row of rows) {
    if (row.signature === prev) break;
    if (state.seenSignatures[row.signature]) continue;
    newRows.push(row);
  }
  state.lastSignature = latest;
  newRows.reverse();

  for (const row of newRows) {
    state.seenSignatures[row.signature] = Date.now();
    const raw = await fetchParsedTransaction(cfg.rpcUrl, row.signature);
    if (!raw) continue;
    const tx = raw as TxJsonParsed;
    const swap = decodeSwapForWallet(tx, cfg.targetWallet, getSolUsd());
    if (!swap || swap.priceUsd <= 0) continue;

    const dex = await fetchDexInfo(swap.baseMint, getSolUsd());
    const symbol = dex?.symbol ?? swap.baseMint.slice(0, 6);
    const mint = swap.baseMint;

    let preLeaderRaw = leaderPreBalanceRaw(state, mint);
    if (swap.side === 'sell' && preLeaderRaw === 0n) {
      const post = await fetchWalletMintBalanceRaw(cfg.rpcUrl, cfg.targetWallet, mint);
      preLeaderRaw = bootstrapLeaderPreSellBalance(post, swap.baseAmountRaw);
    }

    if (swap.side === 'buy') {
      await onLeaderBuy(cfg, state, swap, symbol, row, preLeaderRaw);
    } else {
      await onLeaderSell(cfg, state, swap, symbol, row, preLeaderRaw);
    }
    applyLeaderSwapToLedger(state, mint, swap.side, swap.baseAmountRaw);
    const closedPct = applyLeaderSwapToHistory(state, {
      mint,
      side: swap.side,
      amountUsd: swap.amountUsd,
      leaderBalanceAfterRaw: leaderPreBalanceRaw(state, mint),
      dustRaw: cfg.leaderFlatDustRaw,
      nowMs: Date.now(),
    });
    if (closedPct != null) {
      const stats = leaderMintStats(state, mint);
      appendCopyEvent(cfg, {
        kind: 'leader_session_closed',
        mint,
        symbol,
        leaderSignature: row.signature,
        sessionPct: Number(closedPct.toFixed(2)),
        leaderPriorSessions: stats?.sessions ?? 0,
        leaderPriorAvgPct: stats != null ? Number(stats.avgPct.toFixed(2)) : null,
      });
    }
    await sleep(120);
  }
}

async function onLeaderBuy(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  swap: SwapInsert,
  symbol: string,
  row: SignatureRow,
  preLeaderRaw: bigint,
): Promise<void> {
  const mint = swap.baseMint;
  const priceUsd = swap.priceUsd;
  let existing = state.positions[mint];
  const walletBal = await fetchExecutionWalletBalanceRaw(cfg, mint);

  if (!existing && walletBal > 0n && preLeaderRaw > 0n && !cfg.sharedOscarWallet) {
    existing = ensurePositionFromWallet(state, {
      mint,
      symbol,
      tokenRaw: walletBal,
      priceUsd,
      leaderWallet: cfg.targetWallet,
    }, cfg);
  } else if (existing && walletBal > 0n) {
    syncPositionFromWallet(existing, walletBal, priceUsd, cfg);
  }

  purgeStaleOscarHandoffPosition({ cfg, state, mint, walletMintRaw: walletBal });
  existing = state.positions[mint];

  if (existing) {
    if (hasPendingBuyForMint(state, mint)) return;
    const leaderIgnore = leaderIgnoreBlocksAction(cfg, { mint, copyPosition: existing, walletMintRaw: walletBal });
    if (leaderIgnore) {
      logCopyLeaderIgnored(cfg, {
        mint,
        symbol,
        leaderSignature: row.signature,
        leaderAction: 'add',
        verdict: leaderIgnore,
        oscarPromotedAt: existing.oscarPromotedAt,
      });
      return;
    }
    const dupOnAdd = oscarDupGuardBlocksBuy(cfg, {
      mint,
      walletMintRaw: walletBal,
      priceUsd,
    });
    if (dupOnAdd) {
      logCopyBuySkipped(cfg, {
        mint,
        symbol,
        leaderSignature: row.signature,
        buyKind: 'add',
        verdict: dupOnAdd,
      });
      return;
    }
    if (cfg.maxAddsPerMint > 0 && existing.addCount >= cfg.maxAddsPerMint) {
      appendCopyEvent(cfg, {
        kind: 'leader_add_ignored',
        reason: 'max_adds',
        mint,
        leaderSignature: row.signature,
        positionUsd: existing.sizeUsd,
      });
      return;
    }
    const entryDeployedCostUsd = resolveEntryDeployedCostUsd(cfg, state, existing);
    if (!isEntryFullyDeployed(cfg, entryDeployedCostUsd, existing)) {
      appendCopyEvent(cfg, {
        kind: 'leader_add_ignored',
        reason: 'entry_not_fully_deployed',
        mint,
        leaderSignature: row.signature,
        deployedUsd: entryDeployedCostUsd,
        deployedUsdMtm:
          walletBal > 0n && priceUsd > 0
            ? walletNotionalUsdFromRaw(walletBal, priceUsd)
            : existing.sizeUsd,
        targetUsd: entryTargetDeployUsd(cfg, existing),
        entryMinDeployFraction: cfg.entryMinDeployFraction,
      });
      return;
    }
    const addFrac = leaderAddFraction(preLeaderRaw, swap.baseAmountRaw);
    const ourAddUsd = ourAddUsdFromLeaderAdd({
      ourSizeUsd: entryTargetDeployUsd(cfg, existing),
      addFraction: addFrac,
      maxRoomUsd: positionRoomUsd(cfg, existing),
      minAddUsd: cfg.minProportionalAddUsd,
    });
    if (!canScheduleProportionalAdd(cfg, existing, ourAddUsd)) {
      appendCopyEvent(cfg, {
        kind: 'leader_add_ignored',
        reason: 'proportional_add_too_small_or_cap',
        mint,
        leaderSignature: row.signature,
        leaderAddFraction: addFrac,
        ourAddUsd,
        positionUsd: existing.sizeUsd,
      });
      return;
    }
    await schedulePendingBuy(cfg, state, {
      mint,
      symbol,
      kind: 'add',
      sizeUsd: ourAddUsd,
      leaderAddFraction: addFrac,
      preLeaderRaw,
      swap,
      row,
    });
    return;
  }

  if (hasPendingBuyForMint(state, mint)) return;
  const leaderIgnoreEntry = leaderIgnoreBlocksAction(cfg, { mint, copyPosition: existing });
  if (leaderIgnoreEntry) {
    logCopyLeaderIgnored(cfg, {
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderAction: 'buy',
      verdict: leaderIgnoreEntry,
      oscarPromotedAt: state.positions[mint]?.oscarPromotedAt,
    });
    return;
  }
  const dupOnEntry = oscarDupGuardBlocksBuy(cfg, {
    mint,
    walletMintRaw: walletBal,
    priceUsd,
  });
  if (dupOnEntry) {
    logCopyBuySkipped(cfg, {
      mint,
      symbol,
      leaderSignature: row.signature,
      buyKind: 'entry',
      verdict: dupOnEntry,
    });
    return;
  }
  const lateEntryOnLeaderRebuy = preLeaderRaw > 0n;
  if (shouldIgnoreMissedEntryLeaderRebuy(cfg, preLeaderRaw)) {
    appendCopyEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'missed_entry_leader_already_in',
      mint,
      leaderSignature: row.signature,
      leaderPreBalanceRaw: preLeaderRaw.toString(),
    });
    return;
  }
  if (cfg.maxOpenPositions > 0 && openPositionsCount(state) >= cfg.maxOpenPositions) {
    appendCopyEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'max_open_positions',
      mint,
      leaderSignature: row.signature,
    });
    return;
  }

  const gateBlock = await leaderGateBlocksEntry(cfg, state, mint);
  if (gateBlock) {
    appendCopyEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'copy_gate',
      gateReasons: gateBlock.reasons,
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderBuyUsd: swap.amountUsd,
      leaderPriorSessions: gateBlock.stats?.sessions ?? 0,
      leaderPriorAvgPct:
        gateBlock.stats != null ? Number(gateBlock.stats.avgPct.toFixed(2)) : null,
      pairAgeHours:
        gateBlock.ctx?.pairAgeHours != null ? Number(gateBlock.ctx.pairAgeHours.toFixed(2)) : null,
      buySellRatio5m:
        gateBlock.ctx?.buySellRatio5m != null
          ? Number(gateBlock.ctx.buySellRatio5m.toFixed(2))
          : null,
      priceChange5mPct: gateBlock.ctx?.priceChange5mPct ?? null,
    });
    return;
  }

  if (usesDipOnlyEntry(cfg)) {
    const dex = await fetchDexInfo(mint, getSolUsd());
    const mcap = dex?.marketCap && dex.marketCap > 0 ? dex.marketCap : undefined;
    const targetUsd = entryTargetUsd(cfg, mcap, swap.amountUsd);
    await schedulePendingBuy(cfg, state, {
      mint,
      symbol,
      kind: 'entry',
      sizeUsd: entryDipSizeUsd(cfg, mcap, swap.amountUsd),
      entryLeg: 'dip',
      entryTargetUsd: targetUsd,
      entryMcapUsd: mcap,
      preLeaderRaw,
      swap,
      row,
      lateEntryOnLeaderRebuy,
    });
    return;
  }

  const dex = await fetchDexInfo(mint, getSolUsd());
  const mcap = dex?.marketCap && dex.marketCap > 0 ? dex.marketCap : undefined;
  const targetUsd = entryTargetUsd(cfg, mcap, swap.amountUsd);
  const probeUsd = usesSplitEntryProbe(cfg) ? entryProbeSizeUsd(cfg, mcap, swap.amountUsd) : targetUsd;
  await schedulePendingBuy(cfg, state, {
    mint,
    symbol,
    kind: 'entry',
    sizeUsd: probeUsd,
    entryLeg: usesSplitEntryProbe(cfg) ? 'probe' : undefined,
    entryTargetUsd: targetUsd,
    entryMcapUsd: mcap,
    preLeaderRaw,
    swap,
    row,
    lateEntryOnLeaderRebuy,
  });
}

function markEntryDipAbandoned(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  pos: CopyPosition,
  meta: {
    mint: string;
    leaderSignature: string;
    leaderSellFraction?: number;
  },
): void {
  if (pos.entryDipAbandoned) return;
  if (!shouldAbandonEntryDipOnLeaderSell(cfg, state, pos)) return;
  pos.entryDipAbandoned = true;
  const deployedUsd = resolveEntryDeployedCostUsd(cfg, state, pos);
  appendCopyEvent(cfg, {
    kind: 'entry_dip_abandoned',
    reason: 'leader_exit_before_full_entry',
    mint: meta.mint,
    symbol: pos.symbol,
    leaderSignature: meta.leaderSignature,
    leaderSellFraction: meta.leaderSellFraction ?? null,
    deployedUsd,
    targetUsd: entryTargetDeployUsd(cfg, pos),
  });
}

function scheduleEntryDipBuy(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  probe: PendingBuy,
): void {
  const mcap = probe.entryMcapUsd;
  const dipUsd = entryDipSizeUsd(cfg, mcap, probe.leaderBuyUsd);
  if (!(dipUsd > 0)) return;
  if (state.positions[probe.mint]?.entryDipAbandoned) return;
  if (state.pendingBuys.some((p) => p.mint === probe.mint && p.entryLeg === 'dip')) return;

  const now = Date.now();
  const pending: PendingBuy = {
    id: newId('pb'),
    mint: probe.mint,
    symbol: probe.symbol,
    kind: 'entry',
    entryLeg: 'dip',
    sizeUsd: dipUsd,
    entryTargetUsd: probe.entryTargetUsd,
    entryMcapUsd: mcap,
    leaderSignature: probe.leaderSignature,
    leaderPriceUsd: probe.leaderPriceUsd,
    leaderBuyUsd: probe.leaderBuyUsd,
    leaderBuyTs: probe.leaderBuyTs,
    dueTs: now,
    leaderHoldingsRawAtSignal: probe.leaderHoldingsRawAtSignal,
    retryUntilTs: probe.retryUntilTs,
  };
  state.pendingBuys.push(pending);

  appendCopyEvent(cfg, {
    kind: 'entry_dip_scheduled',
    mint: probe.mint,
    symbol: probe.symbol,
    leaderSignature: probe.leaderSignature,
    leaderPriceUsd: probe.leaderPriceUsd,
    entryDipDiscountPct: cfg.entryDipDiscountPct,
    sizeUsd: dipUsd,
    retryUntilTs: pending.retryUntilTs,
  });
}

async function schedulePendingBuy(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  args: {
    mint: string;
    symbol: string;
    kind: 'entry' | 'add';
    sizeUsd: number;
    entryLeg?: PendingBuy['entryLeg'];
    entryTargetUsd?: number;
    entryMcapUsd?: number;
    leaderAddFraction?: number;
    preLeaderRaw: bigint;
    swap: SwapInsert;
    row: SignatureRow;
    lateEntryOnLeaderRebuy?: boolean;
  },
): Promise<void> {
  const {
    mint,
    symbol,
    kind,
    sizeUsd,
    entryLeg,
    entryTargetUsd,
    entryMcapUsd,
    leaderAddFraction,
    preLeaderRaw,
    swap,
    row,
    lateEntryOnLeaderRebuy,
  } = args;
  const dueTs = Date.now() + entryScheduleDelayMs(cfg, { kind, entryLeg });
  const leaderHoldingsRawAtSignal = (preLeaderRaw + absRawAmount(swap.baseAmountRaw)).toString();
  const pending: PendingBuy = {
    id: newId('pb'),
    mint,
    symbol,
    kind,
    entryLeg,
    sizeUsd,
    entryTargetUsd,
    entryMcapUsd,
    leaderAddFraction,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
    leaderBuyTs: (row.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    dueTs,
    leaderHoldingsRawAtSignal,
    retryUntilTs: computeRetryUntilTs(dueTs, cfg.buyRetryWindowMs),
  };
  state.pendingBuys.push(pending);

  const schedKind =
    kind === 'add'
      ? 'leader_add_scheduled'
      : entryLeg === 'dip'
        ? 'leader_buy_scheduled'
        : 'leader_buy_scheduled';
  appendCopyEvent(cfg, {
    kind: schedKind,
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
    leaderAddFraction: leaderAddFraction ?? null,
    buyDueTs: dueTs,
    buyDelayMs: entryScheduleDelayMs(cfg, { kind, entryLeg }),
    retryUntilTs: pending.retryUntilTs,
    sizeUsd,
    entryLeg: entryLeg ?? null,
    entryProbeFraction: entryLeg === 'probe' ? cfg.entryProbeFraction : null,
    entryDipDiscountPct: entryLeg === 'dip' ? cfg.entryDipDiscountPct : null,
    lateEntryOnLeaderRebuy: lateEntryOnLeaderRebuy ?? false,
  });

  const delayMin = Math.max(1, Math.round(cfg.buyDelayMs / 60_000));
  const pct =
    kind === 'add' && leaderAddFraction != null
      ? ` · ${(leaderAddFraction * 100).toFixed(0)}% of our stack`
      : '';
  await notifyCopyTraderTelegram(
    cfg,
    fmtCopyAlert({
      action: 'leader_buy',
      mint,
      symbol,
      wallet: cfg.targetWallet,
      priceUsd: swap.priceUsd,
      detail:
        kind === 'add'
          ? `Add $${sizeUsd}${pct} queued ~${delayMin} min, retry ${Math.round(cfg.buyRetryWindowMs / 60_000)}m if gates fail`
          : lateEntryOnLeaderRebuy
            ? `Late entry (leader rebuy) $${sizeUsd} queued ~${delayMin} min, retry ${Math.round(cfg.buyRetryWindowMs / 60_000)}m if gates fail`
            : `Buy $${sizeUsd} queued ~${delayMin} min, retry ${Math.round(cfg.buyRetryWindowMs / 60_000)}m if gates fail`,
    }),
  );
}

async function onLeaderSell(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  swap: SwapInsert,
  symbol: string,
  row: SignatureRow,
  preLeaderRaw: bigint,
): Promise<void> {
  const mint = swap.baseMint;
  const walletBal = await fetchExecutionWalletBalanceRaw(cfg, mint);
  purgeStaleOscarHandoffPosition({ cfg, state, mint, walletMintRaw: walletBal });
  const pos = state.positions[mint];
  const leaderIgnore = leaderIgnoreBlocksAction(cfg, { mint, copyPosition: pos, walletMintRaw: walletBal });
  if (leaderIgnore) {
    logCopyLeaderIgnored(cfg, {
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderAction: 'sell',
      verdict: leaderIgnore,
      oscarPromotedAt: pos?.oscarPromotedAt,
    });
    return;
  }

  const sellFrac = leaderSellFraction(preLeaderRaw, swap.baseAmountRaw);

  if (usesOscarExitPolicy(cfg) && copyPositionOscarExitManaged(pos)) {
    const cancelledBuys = cancelPendingBuysForMint(state, mint, 'any');
    for (const c of cancelledBuys) {
      appendCopyEvent(cfg, {
        kind: c.kind === 'add' ? 'add_cancelled' : 'buy_cancelled',
        reason: 'leader_started_exit',
        mint,
        symbol: c.symbol,
        leaderSignature: c.leaderSignature,
        leaderSellFraction: sellFrac,
      });
    }
    if (pos) {
      markEntryDipAbandoned(cfg, state, pos, {
        mint,
        leaderSignature: row.signature,
        leaderSellFraction: sellFrac,
      });
    }
    appendCopyEvent(cfg, {
      kind: 'leader_sell_skipped_oscar_exit',
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderPriceUsd: swap.priceUsd,
      leaderSellFraction: sellFrac,
      exitMode: cfg.exitMode,
    });
    return;
  }

  /** trail_runner owns the exit — do not dump because he dumped. */
  if (usesTrailingExitPolicy(cfg)) {
    const cancelledBuys = cancelPendingBuysForMint(state, mint, 'any');
    for (const c of cancelledBuys) {
      appendCopyEvent(cfg, {
        kind: c.kind === 'add' ? 'add_cancelled' : 'buy_cancelled',
        reason: 'leader_started_exit',
        mint,
        symbol: c.symbol,
        leaderSignature: c.leaderSignature,
        leaderSellFraction: sellFrac,
      });
    }
    if (pos) {
      markEntryDipAbandoned(cfg, state, pos, {
        mint,
        leaderSignature: row.signature,
        leaderSellFraction: sellFrac,
      });
    }
    appendCopyEvent(cfg, {
      kind: 'leader_sell_skipped_own_exit',
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderPriceUsd: swap.priceUsd,
      leaderSellFraction: sellFrac,
      exitMode: cfg.exitMode,
    });
    return;
  }

  if (cfg.minProportionalSellFraction > 0 && sellFrac < cfg.minProportionalSellFraction) {
    appendCopyEvent(cfg, {
      kind: 'leader_sell_ignored',
      reason: 'sell_fraction_too_small',
      mint,
      leaderSignature: row.signature,
      leaderSellFraction: sellFrac,
    });
    return;
  }

  const cancelledBuys = cancelPendingBuysForMint(state, mint, 'any');
  for (const c of cancelledBuys) {
    appendCopyEvent(cfg, {
      kind: c.kind === 'add' ? 'add_cancelled' : 'buy_cancelled',
      reason: 'leader_started_exit',
      mint,
      symbol: c.symbol,
      leaderSignature: c.leaderSignature,
      leaderSellFraction: sellFrac,
    });
  }

  const sellableRaw = copySellableTokenRaw(cfg, pos);
  if (sellableRaw === 0n && !cfg.sharedOscarWallet && walletBal === 0n) {
    if (pos) closePositionForMint(cfg, state, mint, 'wallet_empty_on_leader_sell');
    return;
  }

  let tracked = pos;
  if (!tracked && !cfg.sharedOscarWallet) {
    tracked = ensurePositionFromWallet(state, {
      mint,
      symbol,
      tokenRaw: walletBal,
      priceUsd: swap.priceUsd,
      leaderWallet: cfg.targetWallet,
    }, cfg);
  } else if (tracked && !cfg.sharedOscarWallet) {
    syncPositionFromWallet(tracked, walletBal, swap.priceUsd, cfg);
  } else if (!tracked) {
    return;
  }

  markEntryDipAbandoned(cfg, state, tracked, {
    mint,
    leaderSignature: row.signature,
    leaderSellFraction: sellFrac,
  });

  const postLeaderOnChain = await fetchWalletMintBalanceRaw(cfg.rpcUrl, cfg.targetWallet, mint);
  const ourSellFrac = resolveOurSellFraction({
    leaderSellFraction: sellFrac,
    postLeaderBalanceRaw: postLeaderOnChain,
    dustRaw: cfg.leaderFlatDustRaw,
  });
  const delayMs = randomSellDelayMs(cfg);
  const dueTs = Date.now() + delayMs;
  const pending: PendingSell = {
    id: newId('ps'),
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderSellTs: (row.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    dueTs,
    fraction: ourSellFrac,
    leaderSellFraction: sellFrac,
    retryUntilTs: computeRetryUntilTs(dueTs, cfg.sellRetryWindowMs),
  };
  state.pendingSells.push(pending);

  appendCopyEvent(cfg, {
    kind: 'leader_sell_scheduled',
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderSellFraction: sellFrac,
    ourSellFraction: ourSellFrac,
    sellDueTs: pending.dueTs,
    sellDelayMs: delayMs,
  });

  await notifyCopyTraderTelegram(
    cfg,
    fmtCopyAlert({
      action: 'leader_sell',
      mint,
      symbol,
      wallet: cfg.targetWallet,
      priceUsd: swap.priceUsd,
      detail: `Our ${(ourSellFrac * 100).toFixed(0)}% sell in ~${Math.round(delayMs / 1000)}s`,
    }),
  );
}

export async function processPendingBuys(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const now = Date.now();
  const due = state.pendingBuys.filter((p) => p.dueTs <= now);
  if (due.length === 0) return;

  for (const pending of due) {
    if (isPendingBuyExpired(pending, now)) {
      removePendingBuyById(state, pending.id);
      appendCopyEvent(cfg, {
        kind: pending.kind === 'add' ? 'add_expired' : 'buy_expired',
        mint: pending.mint,
        symbol: pending.symbol,
        leaderSignature: pending.leaderSignature,
        retryUntilTs: pending.retryUntilTs,
      });
      continue;
    }

    let existing = state.positions[pending.mint];

    if (pending.kind === 'entry' && pending.entryLeg === 'dip' && existing?.entryDipAbandoned) {
      removePendingBuyById(state, pending.id);
      appendCopyEvent(cfg, {
        kind: 'buy_cancelled',
        reason: 'entry_dip_abandoned',
        mint: pending.mint,
        symbol: pending.symbol,
        leaderSignature: pending.leaderSignature,
      });
      continue;
    }

    if (pending.kind === 'entry' && pending.entryLeg !== 'dip') {
      if (existing) {
        removePendingBuyById(state, pending.id);
        continue;
      }
      if (cfg.maxOpenPositions > 0 && openPositionsCount(state) >= cfg.maxOpenPositions) {
        if (noteBuyDefer(state, pending.id, now, cfg)) {
          appendCopyEvent(cfg, {
            kind: 'buy_deferred',
            reason: 'max_open_positions',
            mint: pending.mint,
            retryUntilTs: pending.retryUntilTs,
          });
        }
        continue;
      }
    } else if (pending.kind === 'entry' && pending.entryLeg === 'dip' && !existing && usesSplitEntryProbe(cfg)) {
      if (noteBuyDefer(state, pending.id, now, cfg)) {
        appendCopyEvent(cfg, {
          kind: 'buy_deferred',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          reason: 'dip_awaiting_probe_position',
          retryUntilTs: pending.retryUntilTs,
        });
      }
      continue;
    } else if (pending.kind === 'entry' && pending.entryLeg === 'dip' && !existing) {
      if (cfg.maxOpenPositions > 0 && openPositionsCount(state) >= cfg.maxOpenPositions) {
        if (noteBuyDefer(state, pending.id, now, cfg)) {
          appendCopyEvent(cfg, {
            kind: 'buy_deferred',
            reason: 'max_open_positions',
            mint: pending.mint,
            retryUntilTs: pending.retryUntilTs,
          });
        }
        continue;
      }
    } else if (!existing) {
      if (cfg.sharedOscarWallet) {
        removePendingBuyById(state, pending.id);
        appendCopyEvent(cfg, {
          kind: 'add_cancelled',
          reason: 'no_open_position_for_add',
          mint: pending.mint,
          leaderSignature: pending.leaderSignature,
        });
        continue;
      }
      const walletBal = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      if (walletBal > 0n) {
        existing = ensurePositionFromWallet(state, {
          mint: pending.mint,
          symbol: pending.symbol,
          tokenRaw: walletBal,
          priceUsd: pending.leaderPriceUsd,
          leaderWallet: cfg.targetWallet,
        }, cfg);
      } else {
        removePendingBuyById(state, pending.id);
        appendCopyEvent(cfg, {
          kind: 'add_cancelled',
          reason: 'no_open_position_for_add',
          mint: pending.mint,
          leaderSignature: pending.leaderSignature,
        });
        continue;
      }
    } else if (pending.kind === 'add' && cfg.maxAddsPerMint > 0 && existing.addCount >= cfg.maxAddsPerMint) {
      removePendingBuyById(state, pending.id);
      appendCopyEvent(cfg, { kind: 'add_cancelled', reason: 'max_adds', mint: pending.mint });
      continue;
    } else if (
      pending.kind === 'add' &&
      !canScheduleProportionalAdd(cfg, existing, pending.sizeUsd)
    ) {
      removePendingBuyById(state, pending.id);
      appendCopyEvent(cfg, { kind: 'add_cancelled', reason: 'proportional_add_cap', mint: pending.mint });
      continue;
    }

    if (pending.leaderHoldingsRawAtSignal) {
      const signalRaw = BigInt(pending.leaderHoldingsRawAtSignal);
      const ledgerNow = leaderPreBalanceRaw(state, pending.mint);
      if (leaderHoldingsShrunkSinceSignal(signalRaw, ledgerNow)) {
        if (existing && pending.kind !== 'add') {
          markEntryDipAbandoned(cfg, state, existing, {
            mint: pending.mint,
            leaderSignature: pending.leaderSignature,
          });
        }
        removePendingBuyById(state, pending.id);
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_cancelled' : 'buy_cancelled',
          reason: 'leader_started_exit',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          leaderHoldingsRawAtSignal: pending.leaderHoldingsRawAtSignal,
          leaderHoldingsRawNow: ledgerNow.toString(),
        });
        continue;
      }
    }

    const dex = await fetchDexInfo(pending.mint, getSolUsd());
    // Ignore absurd mcap from exotic Dex pairs (same TOKEN/MET garbage that yields ~$128 spot).
    const dexMcapForSizing =
      dex?.marketCap &&
      dex.priceUsd > 0 &&
      pending.leaderPriceUsd > 0 &&
      !isUsdPriceOutlierVsAnchor(dex.priceUsd, pending.leaderPriceUsd, copyDexVsLeaderMaxRatio())
        ? dex.marketCap
        : undefined;
    syncEntryPendingSizing(cfg, pending, dexMcapForSizing);
    const resolved = await resolveCurrentPrice(
      pending.mint,
      dex?.priceUsd ?? 0,
      pending.leaderPriceUsd,
    );
    let currentPrice = resolved.priceUsd;
    let entryPriceSource: 'jupiter_quote' | 'dex' | 'jupiter' | 'leader_fill' | undefined =
      resolved.source === 'none' ? undefined : resolved.source;
    const dexRejectedVsLeader = resolved.rejectedDex;
    const isEntryDip = pending.kind === 'entry' && pending.entryLeg === 'dip';
    const isEntryProbe = isEntryProbePending({
      kind: pending.kind,
      entryLeg: pending.entryLeg,
      usesDipOnly: usesDipOnlyEntry(cfg),
    });

    if (isEntryDip || isEntryProbe) {
      const dipQuoteCache: EntryDipQuoteCache = {
        lastTs: pending.lastDipQuoteTs,
        lastPriceUsd: pending.lastDipQuotePriceUsd,
      };
      const evalPx = await resolveEntryDipEvalPrice({
        cfg,
        mint: pending.mint,
        dipSizeUsd: pending.sizeUsd,
        dexPriceUsd: currentPrice,
        quoteCache: dipQuoteCache,
        nowMs: now,
      });
      pending.lastDipQuoteTs = dipQuoteCache.lastTs;
      pending.lastDipQuotePriceUsd = dipQuoteCache.lastPriceUsd;
      if (evalPx.quoteUnavailable) {
        if (isEntryDip) resetEntryDipPassStreak(state, pending.id);
        if (noteBuyDefer(state, pending.id, now, cfg)) {
          appendCopyEvent(cfg, {
            kind: 'buy_deferred',
            mint: pending.mint,
            symbol: pending.symbol,
            leaderSignature: pending.leaderSignature,
            leaderPriceUsd: pending.leaderPriceUsd,
            currentPriceUsd: currentPrice,
            reason: isEntryProbe ? 'jupiter_probe_quote_unavailable' : 'jupiter_dip_quote_unavailable',
            retryUntilTs: pending.retryUntilTs,
          });
        }
        continue;
      }
      currentPrice = evalPx.priceUsd;
      entryPriceSource = evalPx.source;
    }

    const evalInput = {
      mint: pending.mint,
      leaderPriceUsd: pending.leaderPriceUsd,
      leaderBuyUsd: pending.leaderBuyUsd,
      currentPriceUsd: currentPrice,
      dex,
      nowMs: now,
      probeEntryPriceUsd:
        isEntryDip && existing?.entryPriceUsd > 0 ? existing.entryPriceUsd : undefined,
    };
    const evalResult =
      pending.kind === 'add'
        ? evaluateCopyAdd(cfg, evalInput)
        : isEntryDip
          ? evaluateCopyEntryDip(cfg, evalInput)
          : evaluateCopyEntry(cfg, evalInput);

    if (!evalResult.pass) {
      if (isEntryDip) resetEntryDipPassStreak(state, pending.id);
      const deferNote = noteBuyDefer(state, pending.id, now, cfg);
      if (deferNote) {
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          leaderPriceUsd: pending.leaderPriceUsd,
          currentPriceUsd: currentPrice,
          dexPriceUsd: dex?.priceUsd ?? null,
          entryDipPriceSource: entryPriceSource ?? null,
          dexRejectedVsLeader: dexRejectedVsLeader || null,
          eval: evalResult,
          retryUntilTs: pending.retryUntilTs,
        });
        if (deferNote === 'first') {
          await notifyCopyTraderTelegram(
            cfg,
            fmtCopyAlert({
              action: 'skip',
              mint: pending.mint,
              symbol: pending.symbol,
              wallet: cfg.targetWallet,
              priceUsd: currentPrice,
              detail: `${evalResult.reasons.join(', ')} · retrying until gate pass`,
            }),
          );
        }
      }
      continue;
    }

    if (isEntryDip) {
      const streak = bumpEntryDipPassStreak(state, pending.id);
      if (streak < cfg.entryDipConfirmTicks) {
        if (noteBuyDefer(state, pending.id, now, cfg)) {
          appendCopyEvent(cfg, {
            kind: 'buy_deferred',
            mint: pending.mint,
            symbol: pending.symbol,
            leaderSignature: pending.leaderSignature,
            leaderPriceUsd: pending.leaderPriceUsd,
            currentPriceUsd: currentPrice,
            entryDipPriceSource: entryPriceSource ?? null,
            dipPassStreak: streak,
            entryDipConfirmTicks: cfg.entryDipConfirmTicks,
            reason: entryDipConfirmReason(
              cfg,
              streak,
              currentPrice,
              pending.leaderPriceUsd,
              existing?.entryPriceUsd,
            ),
            eval: evalResult,
            retryUntilTs: pending.retryUntilTs,
          });
        }
        continue;
      }
    }

    if (cfg.sharedOscarWallet) {
      const leaderIgnore = leaderIgnoreBlocksAction(cfg, {
        mint: pending.mint,
        copyPosition: existing,
      });
      if (leaderIgnore) {
        removePendingBuyById(state, pending.id);
        logCopyLeaderIgnored(cfg, {
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          leaderAction: 'pending_buy',
          verdict: leaderIgnore,
          oscarPromotedAt: existing?.oscarPromotedAt,
        });
        continue;
      }

      const walletBalForGuard = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      const dupGuard = oscarDupGuardBlocksBuy(cfg, {
        mint: pending.mint,
        walletMintRaw: walletBalForGuard,
        priceUsd: currentPrice,
      });
      if (dupGuard) {
        removePendingBuyById(state, pending.id);
        logCopyBuySkipped(cfg, {
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          buyKind: pending.kind === 'add' ? 'add' : 'entry',
          verdict: dupGuard,
        });
        continue;
      }
    }

    const funding = await checkCopyFundingGate(cfg, pending.sizeUsd, now);
    if (!funding.ok) {
      if (noteBuyDefer(state, pending.id, now, cfg)) {
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          reason: funding.reason,
          quoteUsd: funding.quoteUsd,
          feeSol: funding.feeSol,
          requiredUsd: funding.requiredUsd,
          retryUntilTs: pending.retryUntilTs,
        });
      }
      continue;
    }

    const spare = await checkCopySpareCapitalGate(cfg, pending.sizeUsd);
    if (!spare.ok) {
      if (noteBuyDefer(state, pending.id, now, cfg)) {
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          reason: spare.reason,
          spareUsd: spare.spareUsd,
          requiredUsd: 'requiredUsd' in spare ? spare.requiredUsd : pending.sizeUsd,
          retryUntilTs: pending.retryUntilTs,
        });
      }
      continue;
    }

    const execKind =
      pending.kind === 'entry' && pending.entryLeg === 'dip' ? ('add' as const) : pending.kind;
    const exec = await executeCopyBuy({
      cfg,
      mint: pending.mint,
      symbol: pending.symbol,
      priceUsd: currentPrice,
      sizeUsd: pending.sizeUsd,
      kind: execKind,
      evalResult,
      leaderSignature: pending.leaderSignature,
    });
    if (!exec.ok) {
      /**
       * Space out the next attempt. A failing swap costs a Jupiter quote plus a
       * build every tick, and a deterministic failure (missing ATA, thin route)
       * will not clear within a second — an unfunded wallet once burned ~100
       * attempts inside one retry window.
       */
      const retryRow = findPendingBuy(state, pending.id);
      if (retryRow && cfg.buyRetryIntervalMs > 0) {
        retryRow.dueTs = now + cfg.buyRetryIntervalMs;
      }
      if (noteBuyDefer(state, pending.id, now, cfg)) {
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          reason: exec.reason ?? 'execution_failed',
          retryUntilTs: pending.retryUntilTs,
          nextAttemptTs: retryRow?.dueTs,
        });
      }
      continue;
    }

    const wasProbe = pending.kind === 'entry' && pending.entryLeg === 'probe';
    const wasEntryDip = pending.kind === 'entry' && pending.entryLeg === 'dip';
    removePendingBuyById(state, pending.id);
    if (wasProbe) {
      scheduleEntryDipBuy(cfg, state, pending);
    }

    const walletBal = cfg.sharedOscarWallet ? 0n : await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
    /**
     * What we actually paid, not the DEX spot the gate looked at. Slippage and
     * price impact put the fill above spot, and booking the cheaper number would
     * overstate every later gain — including the level the trail arms at.
     */
    const fillPriceUsd = exec.priceUsd > 0 ? exec.priceUsd : currentPrice;
    const fillRaw =
      exec.tokenRaw ??
      (fillPriceUsd > 0
        ? BigInt(Math.floor((pending.sizeUsd / fillPriceUsd) * 1_000_000)).toString()
        : undefined);
    if ((pending.kind === 'entry' && pending.entryLeg !== 'dip') || !existing) {
      const tokenRaw = cfg.sharedOscarWallet
        ? fillRaw
        : walletBal > 0n
          ? walletBal.toString()
          : fillRaw;
      const sizeUsd =
        !cfg.sharedOscarWallet && walletBal > 0n && fillPriceUsd > 0
          ? walletNotionalUsdFromRaw(walletBal, fillPriceUsd)
          : pending.sizeUsd;
      state.positions[pending.mint] = {
        mint: pending.mint,
        symbol: pending.symbol,
        positionSource: COPY_LEADER_POSITION_SOURCE,
        entryTs: Date.now(),
        entryPriceUsd: fillPriceUsd,
        sizeUsd,
        tokenRaw,
        addCount: 0,
        entryDeployedCostUsd: pending.sizeUsd,
        entryTargetUsd: pending.entryTargetUsd ?? entryTargetUsd(cfg, pending.entryMcapUsd, pending.leaderBuyUsd),
        entryMcapUsd: pending.entryMcapUsd,
        leaderWallet: cfg.targetWallet,
        leaderEntrySig: pending.leaderSignature,
        ourEntrySig: exec.signature,
      };
    } else {
      const prev = existing;
      const newAvg =
        prev.sizeUsd > 0 && fillPriceUsd > 0
          ? (prev.entryPriceUsd * prev.sizeUsd + fillPriceUsd * pending.sizeUsd) /
            (prev.sizeUsd + pending.sizeUsd)
          : fillPriceUsd;
      if (cfg.sharedOscarWallet) {
        accumulateCopyTokenRaw(prev, fillRaw);
        prev.entryPriceUsd = newAvg;
        prev.sizeUsd = prev.sizeUsd + pending.sizeUsd;
        if (wasEntryDip) {
          prev.entryDeployedCostUsd = (prev.entryDeployedCostUsd ?? 0) + pending.sizeUsd;
        } else if (pending.kind === 'add') {
          prev.addCount = prev.addCount + 1;
        }
        prev.ourEntrySig = exec.signature;
        syncPositionFromWallet(prev, copyTrackedTokenRaw(prev), fillPriceUsd, cfg);
      } else if (walletBal > 0n) {
        syncPositionFromWallet(prev, walletBal, fillPriceUsd, cfg);
        prev.entryPriceUsd = newAvg;
        if (wasEntryDip) {
          prev.entryDeployedCostUsd = (prev.entryDeployedCostUsd ?? 0) + pending.sizeUsd;
        } else if (pending.kind === 'add') {
          prev.addCount = prev.addCount + 1;
        }
        prev.ourEntrySig = exec.signature;
      } else {
        const tokenRaw =
          exec.tokenRaw ??
          (fillPriceUsd > 0
            ? BigInt(Math.floor((pending.sizeUsd / fillPriceUsd) * 1_000_000)).toString()
            : undefined);
        const newSize = prev.sizeUsd + pending.sizeUsd;
        const prevRaw = prev.tokenRaw ? BigInt(prev.tokenRaw) : 0n;
        const addRaw = tokenRaw ? BigInt(tokenRaw) : 0n;
        const next: CopyPosition = {
          ...prev,
          entryPriceUsd: newAvg,
          sizeUsd: newSize,
          tokenRaw: (prevRaw + addRaw).toString(),
          ourEntrySig: exec.signature,
        };
        if (wasEntryDip) {
          next.entryDeployedCostUsd = (prev.entryDeployedCostUsd ?? 0) + pending.sizeUsd;
        } else if (pending.kind === 'add') {
          next.addCount = prev.addCount + 1;
        }
        state.positions[pending.mint] = next;
      }
    }

    const filledPos = state.positions[pending.mint];
    if (filledPos) {
      handoffCopyPositionToOscarExit({
        cfg,
        state,
        pos: filledPos,
        leaderSignature: pending.leaderSignature,
      });
    }

    await notifyCopyTraderTelegram(
      cfg,
      fmtCopyAlert({
        action: 'our_buy',
        mint: pending.mint,
        symbol: pending.symbol,
        wallet: cfg.targetWallet,
        priceUsd: currentPrice,
        detail:
          pending.entryLeg === 'dip'
            ? `Dip leg $${pending.sizeUsd} (−${cfg.entryDipDiscountPct}% vs leader) · score ${evalResult.score}`
            : pending.kind === 'add' && pending.leaderAddFraction != null
              ? `Add $${pending.sizeUsd} (${(pending.leaderAddFraction * 100).toFixed(0)}% stack) · score ${evalResult.score}`
              : pending.entryLeg === 'probe'
                ? `Probe $${pending.sizeUsd} (${(cfg.entryProbeFraction * 100).toFixed(0)}% stack) · score ${evalResult.score}`
                : `${pending.kind === 'add' ? 'Add' : 'Entry'} $${pending.sizeUsd} · score ${evalResult.score}`,
      }),
    );
    await sleep(150);
  }
}

function noteBuyDefer(state: CopyTraderState, pendingId: string, nowMs: number, cfg: CopyTraderConfig): 'first' | 'repeat' | null {
  const row = findPendingBuy(state, pendingId);
  if (!row) return null;
  if (!shouldLogBuyDefer(row, nowMs, cfg.buyRetryDeferLogMs)) return null;
  const first = !row.lastDeferLogTs;
  row.lastDeferLogTs = nowMs;
  return first ? 'first' : 'repeat';
}

export async function processPendingSells(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const now = Date.now();
  if (usesOscarExitPolicy(cfg) && state.pendingSells.length > 0) {
    const dropped = state.pendingSells.length;
    state.pendingSells = [];
    appendCopyEvent(cfg, {
      kind: 'pending_sells_cleared_oscar_exit',
      count: dropped,
      exitMode: cfg.exitMode,
    });
  }
  const due = state.pendingSells.filter((p) => p.dueTs <= now);
  if (due.length === 0) return;

  for (const pending of due) {
    let pos = state.positions[pending.mint];
    const leaderIgnore = leaderIgnoreBlocksAction(cfg, { mint: pending.mint, copyPosition: pos });
    if (leaderIgnore) {
      removePendingSellById(state, pending.id);
      logCopyLeaderIgnored(cfg, {
        mint: pending.mint,
        symbol: pending.symbol ?? pos?.symbol,
        leaderSignature: pending.leaderSignature,
        leaderAction: 'pending_sell',
        verdict: leaderIgnore,
        oscarPromotedAt: pos?.oscarPromotedAt,
      });
      continue;
    }

    const dex = await fetchDexInfo(pending.mint, getSolUsd());
    const exitPrice = (await resolveCurrentPrice(pending.mint, dex?.priceUsd ?? 0)).priceUsd;
    if (!pos) {
      if (cfg.sharedOscarWallet) {
        removePendingSellById(state, pending.id);
        continue;
      }
      const walletBal = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      if (walletBal === 0n) {
        removePendingSellById(state, pending.id);
        continue;
      }
      pos = ensurePositionFromWallet(state, {
        mint: pending.mint,
        symbol: pending.symbol,
        tokenRaw: walletBal,
        priceUsd: exitPrice,
        leaderWallet: cfg.targetWallet,
      }, cfg);
    }

    const sellableRaw = copySellableTokenRaw(cfg, pos);
    if (sellableRaw === 0n) {
      removePendingSellById(state, pending.id);
      closePositionForMint(cfg, state, pending.mint, 'no_copy_token_balance');
      continue;
    }

    if (!cfg.sharedOscarWallet) {
      const walletBal = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      syncPositionFromWallet(pos, walletBal, exitPrice, cfg);
    }

    const sellDelayMs = Math.max(0, now - pending.leaderSellTs);
    const sellNotional = walletNotionalUsdFromRaw(sellableRaw, exitPrice);
    const sellUsd = sellNotional > 0 ? sellNotional * pending.fraction : pos.sizeUsd * pending.fraction;
    const tokenRawBase = sellableRaw.toString();

    if (cfg.minSellIntervalMs > 0 && pos.lastSellTs != null) {
      const sinceLastSell = now - pos.lastSellTs;
      if (sinceLastSell < cfg.minSellIntervalMs) continue;
    }

    const exec = await executeCopySell({
      cfg,
      mint: pending.mint,
      symbol: pending.symbol,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: exitPrice,
      sizeUsd: sellUsd,
      fraction: pending.fraction,
      leaderSignature: pending.leaderSignature,
      sellDelayMs,
      tokenRawBase,
    });

    if (exec.ok) {
      removePendingSellById(state, pending.id);
      pos.lastSellTs = Date.now();
      if (cfg.sharedOscarWallet) {
        if (exec.tokenRawRemaining) {
          pos.tokenRaw = exec.tokenRawRemaining;
        } else if (pending.fraction >= 0.999) {
          delete state.positions[pending.mint];
        } else {
          const soldRaw = BigInt(Math.floor(Number(sellableRaw) * pending.fraction));
          const remain = sellableRaw > soldRaw ? sellableRaw - soldRaw : 0n;
          pos.tokenRaw = remain > 0n ? remain.toString() : undefined;
        }
        if (state.positions[pending.mint]) {
          syncPositionFromWallet(pos, copyTrackedTokenRaw(pos), exitPrice, cfg);
        }
      } else {
        await refreshPositionFromWallet(cfg, state, pending.mint, exitPrice);
      }

      await notifyCopyTraderTelegram(
        cfg,
        fmtCopyAlert({
          action: 'our_sell',
          mint: pending.mint,
          symbol: pending.symbol,
          wallet: cfg.targetWallet,
          priceUsd: exitPrice,
          detail: `Sold ${(pending.fraction * 100).toFixed(0)}% · PnL ${exec.pnlPct != null ? `${exec.pnlPct >= 0 ? '+' : ''}${exec.pnlPct.toFixed(1)}%` : 'n/a'} · delay ${Math.round(sellDelayMs / 1000)}s`,
        }),
      );
      await sleep(150);
      continue;
    }

    const retryable = isSellRetryableError(exec.reason);
    if (retryable && !isPendingSellExpired(pending, now)) {
      const row = findPendingSell(state, pending.id);
      if (row) {
        row.dueTs = now + cfg.sellRetryIntervalMs;
        if (shouldLogSellDefer(row, now, cfg.sellRetryDeferLogMs)) {
          row.lastDeferLogTs = now;
          appendCopyEvent(cfg, {
            kind: 'sell_deferred',
            mint: pending.mint,
            symbol: pending.symbol,
            leaderSignature: pending.leaderSignature,
            sellFraction: pending.fraction,
            reason: exec.reason ?? 'slippage',
            retryUntilTs: row.retryUntilTs,
            nextAttemptTs: row.dueTs,
          });
        }
      }
      await sleep(150);
      continue;
    }

    removePendingSellById(state, pending.id);
    const failReason = exec.reason ?? 'unknown';
    if (failReason.includes('no_token_balance')) {
      closePositionForMint(cfg, state, pending.mint, failReason);
    }
    appendCopyEvent(cfg, {
      kind: retryable && isPendingSellExpired(pending, now) ? 'sell_expired' : 'sell_failed',
      mint: pending.mint,
      symbol: pending.symbol,
      leaderSignature: pending.leaderSignature,
      sellFraction: pending.fraction,
      reason: failReason,
      retryUntilTs: pending.retryUntilTs,
    });
    await sleep(150);
  }
}

export async function runCopyTraderLoop(cfg: CopyTraderConfig): Promise<void> {
  const state = readCopyTraderState(cfg.statePath);
  let lastPoll = 0;
  let lastSolRefresh = 0;
  let lastReconcile = 0;
  let lastTrailTick = 0;
  let lastHistoryGc = 0;

  try {
    const reverted = reconcileIneligibleOscarHandoffs(cfg, state);
    const cleared = await reconcileGhostPositions(cfg, state);
    if (reverted > 0) {
      writeCopyTraderState(cfg.statePath, state);
      console.log('[copy-trader] startup: reverted ineligible oscar handoffs', reverted);
    }
    if (cleared > 0) {
      writeCopyTraderState(cfg.statePath, state);
      console.log('[copy-trader] startup: cleared ghost positions', cleared);
    }
  } catch (err) {
    console.warn('[copy-trader] startup reconcile error', (err as Error).message);
  }

  console.log('[copy-trader] started', {
    target: cfg.targetWallet,
    mode: cfg.executionMode,
    entryUsd: cfg.positionUsd,
    initialMirrorRatio: cfg.initialMirrorRatio > 0 ? cfg.initialMirrorRatio : null,
    addMirror: 'proportional_to_leader',
    maxPositionUsd: cfg.maxPositionUsd > 0 ? cfg.maxPositionUsd : 'unlimited',
    maxAddsPerMint: cfg.maxAddsPerMint > 0 ? cfg.maxAddsPerMint : 'unlimited',
    maxOpenPositions: cfg.maxOpenPositions > 0 ? cfg.maxOpenPositions : 'unlimited',
    buyDelayMin: Math.round(cfg.buyDelayMs / 60_000),
    probeBuyDelaySec: Math.round(cfg.entryProbeBuyDelayMs / 1000),
    buyPriceMaxPremiumPct: cfg.buyPriceMaxPremiumPct,
    buyRetryWindowMin: Math.round(cfg.buyRetryWindowMs / 60_000),
    buyRetryIntervalSec: cfg.buyRetryIntervalMs > 0 ? Math.round(cfg.buyRetryIntervalMs / 1000) : 'every_tick',
    sellRetryWindowMin: Math.round(cfg.sellRetryWindowMs / 60_000),
    sellRetryIntervalSec: Math.round(cfg.sellRetryIntervalMs / 1000),
    sellDelaySec: `${Math.round(cfg.sellDelayMinMs / 1000)}-${Math.round(cfg.sellDelayMaxMs / 1000)}`,
    exitMode: cfg.exitMode,
    trail: usesTrailingExitPolicy(cfg)
      ? `arm+${cfg.trailArmPct}% giveback${cfg.trailGivebackPct}%` +
        (cfg.trailTakeProfitPct > 0 ? ` tp${cfg.trailTakeProfitPct}%` : '') +
        ` cap${Math.round(cfg.trailTimeCapMs / 60_000)}m`
      : null,
    leaderGates: cfg.leaderGatesEnabled
      ? {
          priorSessions: cfg.minLeaderPriorSessions,
          priorAvgPct: cfg.minLeaderPriorAvgPct,
          pairAgeH: `${cfg.entryMinPairAgeHours}-${cfg.entryMaxPairAgeHours}`,
          minBuySell5m: cfg.entryMinBuySellRatio5m,
          maxChase5mPct: cfg.entryMaxChase5mPct,
        }
      : null,
    leaderHistoryMints: Object.keys(state.leaderHistory).length,
    quoteAsset: cfg.quoteAsset,
    minFeeSolReserve: cfg.minFeeSolReserve,
    isolated: true,
  });

  for (;;) {
    const now = Date.now();
    if (now - lastSolRefresh > 120_000) {
      await refreshSolPrice();
      lastSolRefresh = now;
    }

    if (now - lastPoll >= cfg.pollIntervalMs) {
      try {
        await pollLeaderWallet(cfg, state);
        gcSeenSignatures(state, 48 * 3600_000);
        reconcileOscarHandoffClosedFromDisk(cfg, state);
        writeCopyTraderState(cfg.statePath, state);
      } catch (err) {
        console.warn('[copy-trader] poll error', (err as Error).message);
      }
      lastPoll = now;
    }

    if (now - lastHistoryGc >= 3_600_000) {
      const dropped = gcLeaderHistory(state, cfg.leaderHistoryTtlMs, now);
      if (dropped > 0) console.log('[copy-trader] leader history gc', dropped);
      lastHistoryGc = now;
    }

    if (usesTrailingExitPolicy(cfg) && now - lastTrailTick >= cfg.trailTickIntervalMs) {
      try {
        const exits = await processTrailingExits(
          cfg,
          state,
          {
            // No leader anchor here: the outlier guard would clamp a genuine 3×
            // back to our entry and stop the trail from ever arming. Absurd
            // marks are filtered by the sanity band inside processTrailingExits.
            resolvePriceUsd: async (mint) => {
              const dex = await fetchDexInfo(mint, getSolUsd());
              const resolved = await resolveCurrentPrice(mint, dex?.priceUsd ?? 0);
              return resolved.priceUsd;
            },
            scheduleExit: (event) => scheduleTrailExitSell(cfg, state, event),
          },
          now,
        );
        if (exits > 0) console.log('[copy-trader] trail exits scheduled', exits);
      } catch (err) {
        console.warn('[copy-trader] trail exit error', (err as Error).message);
      }
      lastTrailTick = now;
    }

    if (now - lastReconcile >= 60_000) {
      try {
        const reverted = reconcileIneligibleOscarHandoffs(cfg, state);
        const cleared = await reconcileGhostPositions(cfg, state);
        if (reverted > 0) console.log('[copy-trader] reverted ineligible oscar handoffs', reverted);
        if (cleared > 0) console.log('[copy-trader] cleared ghost positions', cleared);
      } catch (err) {
        console.warn('[copy-trader] reconcile error', (err as Error).message);
      }
      lastReconcile = now;
    }

    try {
      await processPendingBuys(cfg, state);
      await processPendingSells(cfg, state);
      /** Flat-tail is leader-follow cleanup — not for trail_runner. */
      if (!usesTrailingExitPolicy(cfg)) {
        const tailSweeps = await scheduleLeaderFlatTailSweeps(cfg, state);
        if (tailSweeps > 0) {
          console.log('[copy-trader] leader-flat tail sweep scheduled', tailSweeps);
        }
      }
      writeCopyTraderState(cfg.statePath, state);
    } catch (err) {
      console.warn('[copy-trader] tick error', (err as Error).message);
    }

    await sleep(cfg.tickIntervalMs);
  }
}
