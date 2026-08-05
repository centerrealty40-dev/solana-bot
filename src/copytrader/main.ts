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
  resolveEntryBuyDelayMs,
  syncEntryPendingSizing,
  usesDipOnlyEntry,
  usesSplitEntryProbe,
} from './entry-probe.js';
import { shouldIgnoreMissedEntryLeaderRebuy } from './entry-late.js';
import {
  enterOnLeaderAddSizeUsd,
  shouldIgnoreFurtherAddsAfterBagEntry,
  shouldIgnoreLeaderFirstBuyForAddEntry,
  usesEnterOnlyOnLeaderAdd,
} from './entry-on-leader-add.js';
import { appendCopyEvent, executeCopyBuy, executeCopySell } from './executor.js';
import { LeaderWalletStream, resolveLeaderStreamWsUrl } from './leader-stream-ws.js';
import { evaluateStreamWatchdog } from './stream-watchdog.js';
import { resolveSellDelayMs } from './sell-delay.js';
import { resolveBuyRetryDelayMs } from './buy-retry-delay.js';
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
  isPendingBuyDoomedByMcap,
  isTerminalCopyBuyEvalFailure,
  sortPendingBuysNewestFirst,
} from './pending-buy-queue.js';
import {
  cancelPendingSellsForMint,
  findPendingSell,
  isPendingSellExhausted,
  isPendingSellExpired,
  isSellRetryableError,
  isUnroutableSellError,
  nextSellRetryDelayMs,
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
import {
  fmtCopyAlert,
  notifyCopyOpsAlert,
  notifyCopyTradePing,
  notifyCopyTraderTelegram,
} from './telegram.js';
import { evaluateCopyOpsWatch } from './ops-watch.js';
import { copyTraderStreamNoiseAlertsEnabled } from './config.js';
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
  copyPositionIsDust,
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
import {
  fundingTopUpRemainderUsd,
  resolveFundingPartialClip,
} from './funding-partial-clip.js';
import { mirrorsLeaderSells, usesOscarExitPolicy, usesTrailingExitPolicy } from './exit-mode.js';
import { fetchCopyEntryContext, type CopyEntryContext } from './entry-context.js';
import { evaluateLeaderMarketGate, evaluateLeaderPriorGate } from './entry-gates.js';
import { evaluateShadowSelect } from './shadow-select.js';
import {
  applyLeaderSwapToHistory,
  gcLeaderHistory,
  leaderMintStats,
  type LeaderMintStats,
} from './leader-history.js';
import { processTrailingExits, type TrailExitEvent } from './trail-exit.js';
import { processVolFadeExits } from './vol-fade-exit.js';
import { processMirrorEarlyTpExits } from './mirror-early-tp.js';
import { processMirrorHoldCapExits } from './mirror-hold-cap.js';
import { handoffCopyPositionToOscarExit } from './copy-oscar-exit-handoff.js';
import {
  copyPositionOscarExitManaged,
  reconcileIneligibleOscarHandoffs,
} from './copy-oscar-handoff-eligibility.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rolling shadow recall counters (leader buys scored this process lifetime). */
const shadowSelectStats = {
  scored: 0,
  wouldBuy: 0,
  miss: 0,
  ctxMissing: 0,
  lastSummaryTs: 0,
};

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
/** Sustained RPC failure → Telegram ALERT (process-watch alone misses this). */
let pollRpcFailStreak = 0;
let lastPollRpcFailAlertMs = 0;
const POLL_RPC_FAIL_ALERT_AFTER = 3;
const POLL_RPC_FAIL_ALERT_COOLDOWN_MS = 15 * 60_000;

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
  ctxHint?: CopyEntryContext | null,
): Promise<LeaderGateBlock | null> {
  if (!cfg.leaderGatesEnabled) return null;

  const stats = leaderMintStats(state, mint);
  const prior = evaluateLeaderPriorGate(cfg, stats);
  if (!prior.pass) return { reasons: prior.reasons, stats, ctx: null };

  const ctx = ctxHint !== undefined ? ctxHint : await fetchCopyEntryContext(mint);
  const market = evaluateLeaderMarketGate(cfg, ctx);
  if (!market.pass) return { reasons: market.reasons, stats, ctx };

  return null;
}

function maybeSummarizeShadowSelect(cfg: CopyTraderConfig): void {
  if (!cfg.shadowSelectEnabled || !(cfg.shadowSelectSummaryMs > 0)) return;
  const now = Date.now();
  if (shadowSelectStats.lastSummaryTs > 0 && now - shadowSelectStats.lastSummaryTs < cfg.shadowSelectSummaryMs) {
    return;
  }
  if (shadowSelectStats.scored <= 0 && shadowSelectStats.lastSummaryTs > 0) return;
  shadowSelectStats.lastSummaryTs = now;
  const recallPct =
    shadowSelectStats.scored > 0
      ? Math.round((shadowSelectStats.wouldBuy / shadowSelectStats.scored) * 1000) / 10
      : 0;
  appendCopyEvent(cfg, {
    kind: 'shadow_select_summary',
    scored: shadowSelectStats.scored,
    wouldBuy: shadowSelectStats.wouldBuy,
    miss: shadowSelectStats.miss,
    ctxMissing: shadowSelectStats.ctxMissing,
    recallPct,
    filterLive: cfg.shadowSelectFilterLive,
    minVolume5mUsd: cfg.shadowSelectMinVolume5mUsd,
    minBuySellRatio5m: cfg.shadowSelectMinBuySellRatio5m,
  });
  console.log('[copy-trader] shadow_select_summary', {
    scored: shadowSelectStats.scored,
    wouldBuy: shadowSelectStats.wouldBuy,
    recallPct,
  });
}

function scheduleTrailExitSell(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  event: TrailExitEvent,
): void {
  const now = Date.now();
  // The trail policy re-arms every tick, so an unsellable position would rebuild
  // the same doomed pending sell forever. Honour the post-abandon cooldown.
  const blockedUntil = event.pos.sellBlockedUntilTs ?? 0;
  if (blockedUntil > now) return;

  const fraction =
    typeof event.fraction === 'number' && event.fraction > 0 ? Math.min(1, event.fraction) : 1;

  // Two concurrent sells on one mint both size off the same pre-sync balance, so
  // the second drains whatever the first left. Keep one in flight — but let a
  // full exit supersede a partial rung, or risk management would be stuck behind it.
  const inFlight = state.pendingSells.filter((p) => p.mint === event.pos.mint);
  if (inFlight.length > 0) {
    if (fraction < 0.999) return;
    if (inFlight.every((p) => p.fraction >= 0.999)) return;
    cancelPendingSellsForMint(state, event.pos.mint);
  }

  const pending: PendingSell = {
    id: newId('ps'),
    mint: event.pos.mint,
    symbol: event.pos.symbol,
    leaderSignature: `trail_exit:${event.reason}`,
    leaderSellTs: now,
    dueTs: now,
    fraction,
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
    sellFraction: fraction,
    heldSec: Math.round(event.heldMs / 1000),
    trailArmPct: cfg.trailArmPct,
    trailGivebackPct: cfg.trailGivebackPct,
    tpRungsTaken: event.tpRungsTaken,
    trailGivebackStepsTaken: event.trailGivebackStepsTaken,
  });
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

export async function pollLeaderWallet(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
): Promise<{ discovered: string[]; applied: number }> {
  const { rows, rpcFailed } = await fetchWalletSignatures(cfg.rpcUrl, cfg.targetWallet, cfg.signatureLimit);
  if (rpcFailed) {
    const now = Date.now();
    pollRpcFailStreak += 1;
    if (now - lastPollRpcFailLogMs >= POLL_RPC_FAIL_LOG_MS) {
      lastPollRpcFailLogMs = now;
      console.warn('[copy-trader] poll: getSignaturesForAddress failed (RPC unreachable or error)');
    }
    if (
      pollRpcFailStreak >= POLL_RPC_FAIL_ALERT_AFTER &&
      now - lastPollRpcFailAlertMs >= POLL_RPC_FAIL_ALERT_COOLDOWN_MS
    ) {
      lastPollRpcFailAlertMs = now;
      void notifyCopyOpsAlert(
        cfg,
        `[ALERT][copy_rpc] ${process.env.COPY_TRADER_APP_NAME || 'copy-trader'}: leader poll RPC failed ×${pollRpcFailStreak} (capacity/unreachable / Helius?). Trading paused until RPC recovers.`,
      );
    }
    return { discovered: [], applied: 0 };
  }
  pollRpcFailStreak = 0;
  if (rows.length === 0) return { discovered: [], applied: 0 };

  const latest = rows[0]!.signature;
  const prev = state.lastSignature;
  if (!prev) {
    state.lastSignature = latest;
    for (const row of rows) state.seenSignatures[row.signature] = Date.now();
    return { discovered: [], applied: 0 };
  }

  const newRows: SignatureRow[] = [];
  for (const row of rows) {
    if (row.signature === prev) break;
    if (state.seenSignatures[row.signature]) continue;
    newRows.push(row);
  }
  state.lastSignature = latest;
  newRows.reverse();

  const applied = await ingestLeaderSignatureRows(cfg, state, newRows, 'poll');
  return { discovered: newRows.map((r) => r.signature), applied };
}

/** Apply one or more leader signatures (stream or poll). Dedupes via seenSignatures. */
export async function ingestLeaderSignatureRows(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  rows: SignatureRow[],
  source: 'poll' | 'stream',
): Promise<number> {
  if (rows.length === 0) return 0;
  const fresh = rows.filter((row) => !state.seenSignatures[row.signature]);
  if (fresh.length === 0) return 0;

  const concurrency = Math.max(1, cfg.leaderIngressConcurrency || 1);
  type Fetched = { row: SignatureRow; raw: unknown | null };
  const fetched: Fetched[] = [];
  for (let i = 0; i < fresh.length; i += concurrency) {
    const chunk = fresh.slice(i, i + concurrency);
    const part = await Promise.all(
      chunk.map(async (row) => ({
        row: { ...row, ingressSource: source },
        raw: await fetchParsedTransaction(cfg.rpcUrl, row.signature),
      })),
    );
    fetched.push(...part);
  }

  let applied = 0;
  for (const { row, raw } of fetched) {
    if (state.seenSignatures[row.signature]) continue;
    // Do NOT mark seen before a successful getTransaction — a null fetch under
    // RPC pressure would permanently silence that leader sig (FxQf RCA 2026-08-04).
    if (!raw) continue;
    state.seenSignatures[row.signature] = Date.now();
    // Poll owns `lastSignature` tip cursor; stream must not rewind it.
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
      noteOpsLeaderBuy(Date.now());
    } else {
      await onLeaderSell(cfg, state, swap, symbol, row, preLeaderRaw);
      noteOpsLeaderActivity(Date.now());
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
        ingressSource: source,
      });
    }
    applied += 1;
  }
  return applied;
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
    if (shouldIgnoreFurtherAddsAfterBagEntry(cfg)) {
      appendCopyEvent(cfg, {
        kind: 'leader_add_ignored',
        reason: 'enter_only_on_leader_add_no_further_adds',
        mint,
        leaderSignature: row.signature,
        positionUsd: existing.sizeUsd,
      });
      return;
    }
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
  if (shouldIgnoreLeaderFirstBuyForAddEntry(cfg, preLeaderRaw)) {
    appendCopyEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'wait_leader_add',
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderBuyUsd: swap.amountUsd,
      leaderPreBalanceRaw: preLeaderRaw.toString(),
    });
    return;
  }
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

  let entryCtx: CopyEntryContext | null | undefined;
  if (cfg.shadowSelectEnabled || cfg.leaderGatesEnabled) {
    entryCtx = await fetchCopyEntryContext(mint);
  }

  if (cfg.shadowSelectEnabled) {
    const shadow = evaluateShadowSelect(cfg, entryCtx ?? null);
    shadowSelectStats.scored += 1;
    if (shadow.wouldBuy) shadowSelectStats.wouldBuy += 1;
    else shadowSelectStats.miss += 1;
    if (shadow.reasons.includes('ctx_missing')) shadowSelectStats.ctxMissing += 1;
    appendCopyEvent(cfg, {
      kind: 'shadow_select',
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderBuyUsd: swap.amountUsd,
      wouldBuy: shadow.wouldBuy,
      reasons: shadow.reasons,
      ruleId: shadow.ruleId,
      volume5mUsd: shadow.metrics.volume5mUsd,
      buySellRatio5m: shadow.metrics.buySellRatio5m,
      marketCapUsd: shadow.metrics.marketCapUsd,
      liquidityUsd: shadow.metrics.liquidityUsd,
      pairAgeHours: shadow.metrics.pairAgeHours,
      priceChange5mPct: shadow.metrics.priceChange5mPct,
      filterLive: cfg.shadowSelectFilterLive,
    });
    if (cfg.shadowSelectFilterLive && !shadow.wouldBuy) {
      appendCopyEvent(cfg, {
        kind: 'leader_buy_ignored',
        reason: 'shadow_select_miss',
        gateReasons: shadow.reasons,
        mint,
        symbol,
        leaderSignature: row.signature,
        leaderBuyUsd: swap.amountUsd,
        marketCapUsd: shadow.metrics.marketCapUsd,
        liquidityUsd: shadow.metrics.liquidityUsd,
      });
      return;
    }
  }

  const gateBlock = await leaderGateBlocksEntry(cfg, state, mint, entryCtx);
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
      marketCapUsd: gateBlock.ctx?.marketCapUsd ?? null,
      liquidityUsd: gateBlock.ctx?.liquidityUsd ?? null,
      volume5mUsd: gateBlock.ctx?.volume5mUsd ?? null,
    });
    return;
  }

  /**
   * Mcap/liq floors live in evaluateCopyEntry (exec time). Without this check at
   * schedule time, sub-floor mints enter pendingBuys and retry for hours —
   * starving fresh chases (see 1.11.645 pending-queue RCA).
   */
  const dexGate = await fetchDexInfo(mint, getSolUsd());
  const structural: string[] = [];
  if (cfg.minMarketCapUsd > 0) {
    const mcap = dexGate?.marketCap;
    if (!(mcap != null && mcap > 0)) structural.push(`mcap_missing_or_zero<min=${cfg.minMarketCapUsd}`);
    else if (mcap < cfg.minMarketCapUsd) {
      structural.push(`mcap=${Math.round(mcap)}<min=${cfg.minMarketCapUsd}`);
    }
  }
  if (cfg.minLiquidityUsd > 0) {
    const liq = dexGate?.liquidityUsd;
    if (!(liq != null && liq > 0)) structural.push(`liq_missing_or_zero<min=${cfg.minLiquidityUsd}`);
    else if (liq < cfg.minLiquidityUsd) {
      structural.push(`liq=${Math.round(liq)}<min=${cfg.minLiquidityUsd}`);
    }
  }
  if (structural.length > 0) {
    appendCopyEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'copy_gate',
      gateReasons: structural,
      mint,
      symbol,
      leaderSignature: row.signature,
      leaderBuyUsd: swap.amountUsd,
      marketCapUsd: dexGate?.marketCap ?? null,
      liquidityUsd: dexGate?.liquidityUsd ?? null,
    });
    return;
  }

  if (usesEnterOnlyOnLeaderAdd(cfg) && lateEntryOnLeaderRebuy) {
    const bagEntryUsd = enterOnLeaderAddSizeUsd(cfg, {
      preLeaderRaw,
      buyRaw: swap.baseAmountRaw,
      priceUsd: swap.priceUsd > 0 ? swap.priceUsd : priceUsd,
    });
    if (!(bagEntryUsd > 0) || bagEntryUsd < cfg.minLeaderBuyUsd) {
      appendCopyEvent(cfg, {
        kind: 'leader_buy_ignored',
        reason: 'leader_add_bag_entry_too_small',
        mint,
        symbol,
        leaderSignature: row.signature,
        leaderBuyUsd: swap.amountUsd,
        ourEntryUsd: bagEntryUsd,
        enterOnLeaderAddBagRatio: cfg.enterOnLeaderAddBagRatio,
      });
      return;
    }
    const dexBag = await fetchDexInfo(mint, getSolUsd());
    const mcapBag = dexBag?.marketCap && dexBag.marketCap > 0 ? dexBag.marketCap : undefined;
    await schedulePendingBuy(cfg, state, {
      mint,
      symbol,
      kind: 'entry',
      sizeUsd: bagEntryUsd,
      entryTargetUsd: bagEntryUsd,
      entryMcapUsd: mcapBag,
      preLeaderRaw,
      swap,
      row,
      lateEntryOnLeaderRebuy: true,
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

function scheduleFundingTopUpBuy(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  filled: PendingBuy,
  pos: CopyPosition,
): void {
  if (!cfg.fundingPartialClipEnabled) return;
  if (filled.kind !== 'entry') return;
  /**
   * Staged probe→dip: the dip leg still covers the back half of entryTarget.
   * Only top up an under-filled probe (or a single-shot / dip-only / prior top-up).
   */
  if (usesSplitEntryProbe(cfg) && filled.entryLeg === 'probe' && !filled.fundingTopUp) {
    const probeTarget = entryProbeSizeUsd(cfg, filled.entryMcapUsd ?? pos.entryMcapUsd, filled.leaderBuyUsd);
    const deployed = pos.entryDeployedCostUsd ?? filled.sizeUsd;
    const rem = fundingTopUpRemainderUsd({
      entryTargetUsd: probeTarget,
      deployedUsd: deployed,
      minUsd: cfg.fundingPartialClipMinUsd,
    });
    if (!(rem > 0)) return;
    if (state.pendingBuys.some((p) => p.mint === filled.mint && p.fundingTopUp)) return;
    pushFundingTopUpPending(cfg, state, filled, pos, rem, probeTarget, deployed);
    return;
  }

  const topUpTo =
    filled.fundingTopUpToUsd ??
    filled.entryTargetUsd ??
    pos.entryTargetUsd ??
    entryTargetUsd(cfg, filled.entryMcapUsd ?? pos.entryMcapUsd, filled.leaderBuyUsd);
  const deployed = pos.entryDeployedCostUsd ?? resolveEntryDeployedCostUsd(cfg, state, pos);
  const rem = fundingTopUpRemainderUsd({
    entryTargetUsd: topUpTo,
    deployedUsd: deployed,
    minUsd: cfg.fundingPartialClipMinUsd,
  });
  if (!(rem > 0)) return;
  if (state.pendingBuys.some((p) => p.mint === filled.mint && p.fundingTopUp)) return;
  pushFundingTopUpPending(cfg, state, filled, pos, rem, topUpTo, deployed);
}

function pushFundingTopUpPending(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  filled: PendingBuy,
  pos: CopyPosition,
  rem: number,
  topUpToUsd: number,
  deployed: number,
): void {
  const now = Date.now();
  const entryTarget =
    filled.entryTargetUsd ??
    pos.entryTargetUsd ??
    entryTargetUsd(cfg, filled.entryMcapUsd ?? pos.entryMcapUsd, filled.leaderBuyUsd);
  const pending: PendingBuy = {
    id: newId('pb'),
    mint: filled.mint,
    symbol: filled.symbol,
    kind: 'entry',
    entryLeg: filled.entryLeg === 'dip' ? 'dip' : filled.entryLeg,
    sizeUsd: rem,
    entryTargetUsd: entryTarget,
    entryMcapUsd: filled.entryMcapUsd ?? pos.entryMcapUsd,
    leaderSignature: filled.leaderSignature,
    leaderPriceUsd: filled.leaderPriceUsd,
    leaderBuyUsd: filled.leaderBuyUsd,
    leaderBuyTs: filled.leaderBuyTs,
    dueTs: now,
    leaderHoldingsRawAtSignal: filled.leaderHoldingsRawAtSignal,
    retryUntilTs: Math.max(filled.retryUntilTs, computeRetryUntilTs(now, cfg.buyRetryWindowMs)),
    fundingTopUp: true,
    fundingTopUpToUsd: topUpToUsd,
  };
  state.pendingBuys.push(pending);
  appendCopyEvent(cfg, {
    kind: 'funding_topup_scheduled',
    mint: filled.mint,
    symbol: filled.symbol,
    leaderSignature: filled.leaderSignature,
    sizeUsd: rem,
    entryTargetUsd: entryTarget,
    fundingTopUpToUsd: topUpToUsd,
    deployedUsd: deployed,
    retryUntilTs: pending.retryUntilTs,
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
  const dexNow = await fetchDexInfo(mint, getSolUsd());
  const mark = await resolveCurrentPrice(mint, dexNow?.priceUsd ?? 0, swap.priceUsd);
  const baseDelayMs = entryScheduleDelayMs(cfg, { kind, entryLeg });
  const delayMs = resolveEntryBuyDelayMs(cfg, {
    kind,
    entryLeg,
    leaderPriceUsd: swap.priceUsd,
    currentPriceUsd: mark.priceUsd,
  });
  const dueTs = Date.now() + delayMs;
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
  const premiumPct =
    swap.priceUsd > 0 && mark.priceUsd > 0
      ? Number((((mark.priceUsd / swap.priceUsd - 1) * 100)).toFixed(2))
      : null;
  appendCopyEvent(cfg, {
    kind: schedKind,
    mint,
    symbol,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
    leaderAddFraction: leaderAddFraction ?? null,
    buyDueTs: dueTs,
    buyDelayMs: delayMs,
    buyDelaySkipped: baseDelayMs > 0 && delayMs === 0,
    markPremiumPct: premiumPct,
    retryUntilTs: pending.retryUntilTs,
    sizeUsd,
    entryLeg: entryLeg ?? null,
    ingressSource: row.ingressSource ?? undefined,
    entryProbeFraction: entryLeg === 'probe' ? cfg.entryProbeFraction : null,
    entryDipDiscountPct: entryLeg === 'dip' ? cfg.entryDipDiscountPct : null,
    lateEntryOnLeaderRebuy: lateEntryOnLeaderRebuy ?? false,
  });

  const delayMin = Math.max(1, Math.round(cfg.buyDelayMs / 60_000));
  const pct =
    kind === 'add' && leaderAddFraction != null
      ? ` · ${(leaderAddFraction * 100).toFixed(0)}% of our stack`
      : '';
  await notifyCopyTradePing(
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
  /** Any leader peel after our entry blocks the one-shot early TP. */
  if (pos) pos.leaderSoldSinceEntry = true;
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
  if (!tracked) {
    if (walletBal === 0n) return;
    tracked = ensurePositionFromWallet(state, {
      mint,
      symbol,
      tokenRaw: walletBal,
      priceUsd: swap.priceUsd,
      leaderWallet: cfg.targetWallet,
    }, cfg);
    if (cfg.sharedOscarWallet && !copyTrackedTokenRaw(tracked)) {
      tracked.tokenRaw = walletBal.toString();
      syncPositionFromWallet(tracked, walletBal, swap.priceUsd, cfg);
    }
  } else if (!cfg.sharedOscarWallet) {
    syncPositionFromWallet(tracked, walletBal, swap.priceUsd, cfg);
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
  const dexNow = await fetchDexInfo(mint, getSolUsd());
  const mark = await resolveCurrentPrice(mint, dexNow?.priceUsd ?? 0, swap.priceUsd);
  const sellDelay = resolveSellDelayMs(cfg, {
    entryPriceUsd: tracked.entryPriceUsd,
    currentPriceUsd: mark.priceUsd > 0 ? mark.priceUsd : null,
    leaderSellPriceUsd: swap.priceUsd,
  });
  const delayMs = sellDelay.delayMs;
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
    sellDelaySkipMaxDropPct: cfg.sellDelaySkipMaxDropPct,
    sellDelayDropPct: sellDelay.dropPct != null ? Number(sellDelay.dropPct.toFixed(2)) : null,
    sellDelaySkipped: sellDelay.skipped,
    markPriceUsd: mark.priceUsd > 0 ? mark.priceUsd : null,
    entryPriceUsd: tracked.entryPriceUsd > 0 ? tracked.entryPriceUsd : null,
  });

  await notifyCopyTradePing(
    cfg,
    fmtCopyAlert({
      action: 'leader_sell',
      mint,
      symbol,
      wallet: cfg.targetWallet,
      priceUsd: swap.priceUsd,
      detail:
        delayMs <= 0
          ? `Our ${(ourSellFrac * 100).toFixed(0)}% sell now` +
            (sellDelay.dropPct != null ? ` (drop ${sellDelay.dropPct.toFixed(1)}%)` : '')
          : `Our ${(ourSellFrac * 100).toFixed(0)}% sell in ~${Math.round(delayMs / 1000)}s` +
            (sellDelay.dropPct != null ? ` (drop ${sellDelay.dropPct.toFixed(1)}%)` : ''),
    }),
  );
}

export async function processPendingBuys(cfg: CopyTraderConfig, state: CopyTraderState): Promise<void> {
  const now = Date.now();

  /** Purge doomed sub-floor rows left from before schedule-time mcap gate. */
  if (cfg.minMarketCapUsd > 0) {
    for (const p of [...state.pendingBuys]) {
      if (!isPendingBuyDoomedByMcap(p, cfg.minMarketCapUsd)) continue;
      removePendingBuyById(state, p.id);
      appendCopyEvent(cfg, {
        kind: p.kind === 'add' ? 'add_cancelled' : 'buy_cancelled',
        reason: 'entry_gate_terminal',
        gateReasons: [`mcap=${Math.round(p.entryMcapUsd ?? 0)}<min=${cfg.minMarketCapUsd}`],
        mint: p.mint,
        symbol: p.symbol,
        leaderSignature: p.leaderSignature,
        entryMcapUsd: p.entryMcapUsd ?? null,
      });
    }
  }

  const due = sortPendingBuysNewestFirst(state.pendingBuys.filter((p) => p.dueTs <= now));
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
      if (existing && !pending.fundingTopUp) {
        removePendingBuyById(state, pending.id);
        continue;
      }
      if (pending.fundingTopUp && !existing) {
        removePendingBuyById(state, pending.id);
        appendCopyEvent(cfg, {
          kind: 'buy_cancelled',
          reason: 'funding_topup_no_position',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
        });
        continue;
      }
      if (!existing && cfg.maxOpenPositions > 0 && openPositionsCount(state) >= cfg.maxOpenPositions) {
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
    if (pending.fundingTopUp) {
      const ceiling =
        pending.fundingTopUpToUsd ??
        pending.entryTargetUsd ??
        entryTargetUsd(cfg, pending.entryMcapUsd, pending.leaderBuyUsd);
      const deployed = existing
        ? (existing.entryDeployedCostUsd ?? resolveEntryDeployedCostUsd(cfg, state, existing))
        : 0;
      const rem = fundingTopUpRemainderUsd({
        entryTargetUsd: ceiling,
        deployedUsd: deployed,
        minUsd: cfg.fundingPartialClipMinUsd,
      });
      if (pending.entryTargetUsd == null) {
        pending.entryTargetUsd = entryTargetUsd(
          cfg,
          pending.entryMcapUsd,
          pending.leaderBuyUsd,
        );
      }
      pending.fundingTopUpToUsd = ceiling;
      if (!(rem > 0)) {
        removePendingBuyById(state, pending.id);
        appendCopyEvent(cfg, {
          kind: 'buy_cancelled',
          reason: 'funding_topup_complete',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          entryTargetUsd: pending.entryTargetUsd,
          fundingTopUpToUsd: ceiling,
          deployedUsd: deployed,
        });
        continue;
      }
      pending.sizeUsd = rem;
    }
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
      if (isTerminalCopyBuyEvalFailure(evalResult.reasons)) {
        removePendingBuyById(state, pending.id);
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_cancelled' : 'buy_cancelled',
          reason: 'entry_gate_terminal',
          gateReasons: evalResult.reasons,
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          leaderPriceUsd: pending.leaderPriceUsd,
          currentPriceUsd: currentPrice,
          eval: evalResult,
        });
        continue;
      }
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
          await notifyCopyTradePing(
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

    if (cfg.maxPositionUsd > 0 && pending.sizeUsd > cfg.maxPositionUsd) {
      pending.sizeUsd = cfg.maxPositionUsd;
      if (pending.entryTargetUsd != null && pending.entryTargetUsd > cfg.maxPositionUsd) {
        pending.entryTargetUsd = cfg.maxPositionUsd;
      }
    }

    /**
     * Always probe the full synced size first. On shortfall, shrink to the 50%
     * clip and remember it so we only journal `*_funding_partial_clip` once
     * per size (retries keep the clip without re-expanding every tick).
     */
    const fullAttemptUsd = pending.sizeUsd;
    let funding = await checkCopyFundingGate(cfg, fullAttemptUsd, now);
    if (funding.ok) {
      pending.fundingClipUsd = undefined;
    } else if (
      funding.reason === 'insufficient_usdc' &&
      cfg.fundingPartialClipEnabled
    ) {
      const decision = resolveFundingPartialClip({
        enabled: true,
        requiredUsd: fullAttemptUsd,
        availableUsd: funding.quoteUsd,
        fraction: cfg.fundingPartialClipFraction,
        minUsd: cfg.fundingPartialClipMinUsd,
      });
      if (decision.action === 'clip') {
        if (pending.entryTargetUsd == null || pending.entryTargetUsd < decision.originalUsd) {
          pending.entryTargetUsd = Math.max(pending.entryTargetUsd ?? 0, decision.originalUsd);
        }
        const alreadyClipped =
          pending.fundingClipUsd != null &&
          Math.abs(pending.fundingClipUsd - decision.clipUsd) < 0.02;
        pending.sizeUsd = decision.clipUsd;
        pending.fundingClipUsd = decision.clipUsd;
        if (!alreadyClipped) {
          appendCopyEvent(cfg, {
            kind: pending.kind === 'add' ? 'add_funding_partial_clip' : 'buy_funding_partial_clip',
            mint: pending.mint,
            symbol: pending.symbol,
            leaderSignature: pending.leaderSignature,
            fromUsd: fullAttemptUsd,
            toUsd: decision.clipUsd,
            remainderUsd: decision.remainderUsd,
            quoteUsd: funding.quoteUsd,
            entryTargetUsd: pending.entryTargetUsd ?? null,
            fundingTopUp: pending.fundingTopUp === true,
          });
        }
        funding = await checkCopyFundingGate(cfg, pending.sizeUsd, now);
      }
    }
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
      leaderPriceUsd: pending.leaderPriceUsd,
      leaderBuyTs: pending.leaderBuyTs,
    });
    if (!exec.ok) {
      /**
       * Space out the next attempt. Quote-premium misses keep retrying until the
       * price cools or the leader starts exiting (leaderHoldingsShrunkSinceSignal
       * cancels above). A failing swap costs a Jupiter quote plus a build every
       * tick — interval keeps a hot mint from monopolising the buy loop.
       */
      const retryRow = findPendingBuy(state, pending.id);
      if (retryRow && cfg.buyRetryIntervalMs > 0) {
        retryRow.dueTs = now + resolveBuyRetryDelayMs(cfg.buyRetryIntervalMs, exec.reason);
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
    const wasFundingTopUp = pending.fundingTopUp === true;
    const filledEntryKind = pending.kind === 'entry';
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
    if (
      (pending.kind === 'entry' && pending.entryLeg !== 'dip' && !wasFundingTopUp) ||
      !existing
    ) {
      const tokenRaw = cfg.sharedOscarWallet
        ? fillRaw
        : walletBal > 0n
          ? walletBal.toString()
          : fillRaw;
      const sizeUsd =
        !cfg.sharedOscarWallet && walletBal > 0n && fillPriceUsd > 0
          ? walletNotionalUsdFromRaw(walletBal, fillPriceUsd)
          : pending.sizeUsd;
      const needsEntryVolume =
        cfg.volFadeCheckIntervalMs > 0 ||
        (cfg.mirrorHoldCapMs > 0 && cfg.mirrorHoldCapVolOkMs > cfg.mirrorHoldCapMs);
      const entryCtx = needsEntryVolume ? await fetchCopyEntryContext(pending.mint) : null;
      const entryVolume5mUsd =
        entryCtx?.volume5mUsd != null && entryCtx.volume5mUsd > 0 ? entryCtx.volume5mUsd : undefined;
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
        entryVolume5mUsd,
        volume5mSamples: entryVolume5mUsd != null ? [entryVolume5mUsd] : undefined,
        lastVolFadeCheckTs: Date.now(),
        lastVolume5mUsd: entryVolume5mUsd,
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
        if (wasEntryDip || wasFundingTopUp) {
          prev.entryDeployedCostUsd = (prev.entryDeployedCostUsd ?? 0) + pending.sizeUsd;
        } else if (pending.kind === 'add') {
          prev.addCount = prev.addCount + 1;
        }
        prev.ourEntrySig = exec.signature;
        syncPositionFromWallet(prev, copyTrackedTokenRaw(prev), fillPriceUsd, cfg);
      } else if (walletBal > 0n) {
        syncPositionFromWallet(prev, walletBal, fillPriceUsd, cfg);
        prev.entryPriceUsd = newAvg;
        if (wasEntryDip || wasFundingTopUp) {
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
        if (wasEntryDip || wasFundingTopUp) {
          next.entryDeployedCostUsd = (prev.entryDeployedCostUsd ?? 0) + pending.sizeUsd;
        } else if (pending.kind === 'add') {
          next.addCount = prev.addCount + 1;
        }
        state.positions[pending.mint] = next;
      }
    }

    const filledPos = state.positions[pending.mint];
    if (filledPos) {
      if (filledEntryKind && pending.entryTargetUsd != null && pending.entryTargetUsd > 0) {
        filledPos.entryTargetUsd = pending.entryTargetUsd;
      }
      handoffCopyPositionToOscarExit({
        cfg,
        state,
        pos: filledPos,
        leaderSignature: pending.leaderSignature,
      });
      if (filledEntryKind) {
        scheduleFundingTopUpBuy(cfg, state, pending, filledPos);
      }
    }

    noteOpsOurBuy(Date.now());
    await notifyCopyTradePing(
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

/** ---- ops-only watch metrics (no trade TG) ---- */
const opsMetrics = {
  lastLeaderActivityTs: 0,
  lastOurBuyTs: 0,
  leaderBuyTs: [] as number[],
  lastAlertByKey: {} as Record<string, number>,
  lastTickMs: 0,
};

function noteOpsLeaderActivity(ts: number): void {
  opsMetrics.lastLeaderActivityTs = Math.max(opsMetrics.lastLeaderActivityTs, ts);
}

function noteOpsLeaderBuy(ts: number): void {
  noteOpsLeaderActivity(ts);
  opsMetrics.leaderBuyTs.push(ts);
  if (opsMetrics.leaderBuyTs.length > 200) {
    opsMetrics.leaderBuyTs.splice(0, opsMetrics.leaderBuyTs.length - 200);
  }
}

function noteOpsOurBuy(ts: number): void {
  opsMetrics.lastOurBuyTs = Math.max(opsMetrics.lastOurBuyTs, ts);
}

function readOpsIntEnv(name: string, fallback: number): number {
  const s = process.env[name]?.trim();
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function tickCopyOpsWatch(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  leaderStream: LeaderWalletStream | null,
  now: number,
): Promise<void> {
  if (process.env.COPY_TRADER_OPS_WATCH_ENABLED === '0') return;
  const intervalMs = readOpsIntEnv('COPY_TRADER_OPS_WATCH_INTERVAL_MS', 60_000);
  if (now - opsMetrics.lastTickMs < intervalMs) return;
  opsMetrics.lastTickMs = now;

  const buyStallMs = readOpsIntEnv('COPY_TRADER_OPS_BUY_STALL_ALERT_MS', 7_200_000);
  const cutoff = now - Math.max(buyStallMs, 1);
  const leaderBuysInWindow = opsMetrics.leaderBuyTs.filter((t) => t >= cutoff).length;
  const health = leaderStream?.getHealth() ?? null;

  const alerts = evaluateCopyOpsWatch(
    {
      nowMs: now,
      appName: process.env.COPY_TRADER_APP_NAME || 'copy-trader',
      lastLeaderActivityTs: opsMetrics.lastLeaderActivityTs,
      lastOurBuyTs: opsMetrics.lastOurBuyTs,
      leaderBuysInWindow,
      positions: Object.values(state.positions).map((p) => ({
        mint: p.mint,
        entryTs: p.entryTs,
        sellBlockedUntilTs: p.sellBlockedUntilTs,
        symbol: p.symbol,
      })),
      pendingSells: state.pendingSells.map((s) => ({
        mint: s.mint,
        leaderSellTs: s.leaderSellTs,
        attempts: s.attempts,
        symbol: s.symbol,
      })),
      stream: cfg.leaderStreamEnabled
        ? {
            subscribed: health?.subscribed ?? false,
            notifyCount: health?.notifyCount ?? 0,
            lastSubscribedAtMs: health?.lastSubscribedAtMs ?? 0,
            lastNotifyAtMs: health?.lastNotifyAtMs ?? 0,
          }
        : null,
    },
    {
      leaderIdleMs: readOpsIntEnv('COPY_TRADER_OPS_LEADER_IDLE_ALERT_MS', 21_600_000),
      buyStallMs,
      stuckSellMs: readOpsIntEnv('COPY_TRADER_OPS_STUCK_SELL_ALERT_MS', 1_800_000),
      streamDeadMs: readOpsIntEnv('COPY_TRADER_OPS_STREAM_DEAD_ALERT_MS', 900_000),
    },
  );

  const cooldownMs = readOpsIntEnv('COPY_TRADER_OPS_ALERT_COOLDOWN_MS', 3_600_000);
  for (const alert of alerts) {
    const last = opsMetrics.lastAlertByKey[alert.key] ?? 0;
    if (cooldownMs > 0 && now - last < cooldownMs) continue;
    opsMetrics.lastAlertByKey[alert.key] = now;
    console.warn('[copy-trader] ops alert', alert.key, alert.text);
    await notifyCopyOpsAlert(cfg, alert.text);
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
      const walletBal = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      if (walletBal === 0n) {
        removePendingSellById(state, pending.id);
        continue;
      }
      /** Shared Oscar: rebuild copy leg from wallet so a lost state row cannot mute a due sell. */
      pos = ensurePositionFromWallet(state, {
        mint: pending.mint,
        symbol: pending.symbol,
        tokenRaw: walletBal,
        priceUsd: exitPrice,
        leaderWallet: cfg.targetWallet,
      }, cfg);
      if (cfg.sharedOscarWallet && !copyTrackedTokenRaw(pos)) {
        pos.tokenRaw = walletBal.toString();
        syncPositionFromWallet(pos, walletBal, exitPrice, cfg);
      }
    }

    // Reconcile before sizing, not after: sizing off the pre-sync state sells an
    // amount the wallet no longer holds, and every such attempt is unquotable.
    if (!cfg.sharedOscarWallet) {
      const walletBal = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      syncPositionFromWallet(pos, walletBal, exitPrice, cfg);
    }

    const sellableRaw = copySellableTokenRaw(cfg, pos);
    if (copyPositionIsDust(cfg, sellableRaw, exitPrice)) {
      removePendingSellById(state, pending.id);
      closePositionForMint(
        cfg,
        state,
        pending.mint,
        sellableRaw === 0n ? 'no_copy_token_balance' : 'copy_token_balance_dust',
      );
      continue;
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

      await notifyCopyTradePing(
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

    const liveRow = findPendingSell(state, pending.id);
    const attempts = (liveRow?.attempts ?? pending.attempts ?? 0) + 1;
    const unroutable = isUnroutableSellError(exec.reason);
    const unroutableAttempts =
      (liveRow?.unroutableAttempts ?? pending.unroutableAttempts ?? 0) + (unroutable ? 1 : 0);
    if (liveRow) {
      liveRow.attempts = attempts;
      liveRow.unroutableAttempts = unroutableAttempts;
    }

    const retryable = isSellRetryableError(exec.reason);
    const exhausted =
      isPendingSellExhausted({ ...pending, attempts }, cfg.sellMaxAttempts) ||
      (unroutable &&
        isPendingSellExhausted(
          { ...pending, attempts: unroutableAttempts },
          cfg.sellMaxUnroutableAttempts,
        ));
    if (retryable && !exhausted && !isPendingSellExpired(pending, now)) {
      if (liveRow) {
        liveRow.dueTs =
          now +
          nextSellRetryDelayMs(attempts, cfg.sellRetryIntervalMs, cfg.sellRetryBackoffMaxMs);
        if (shouldLogSellDefer(liveRow, now, cfg.sellRetryDeferLogMs)) {
          liveRow.lastDeferLogTs = now;
          appendCopyEvent(cfg, {
            kind: 'sell_deferred',
            mint: pending.mint,
            symbol: pending.symbol,
            leaderSignature: pending.leaderSignature,
            sellFraction: pending.fraction,
            reason: exec.reason ?? 'slippage',
            attempts,
            unroutableAttempts,
            retryUntilTs: liveRow.retryUntilTs,
            nextAttemptTs: liveRow.dueTs,
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
    const kind = exhausted
      ? 'sell_abandoned'
      : retryable && isPendingSellExpired(pending, now)
        ? 'sell_expired'
        : 'sell_failed';
    appendCopyEvent(cfg, {
      kind,
      mint: pending.mint,
      symbol: pending.symbol,
      leaderSignature: pending.leaderSignature,
      sellFraction: pending.fraction,
      reason: failReason,
      attempts,
      unroutableAttempts,
      maxAttempts: cfg.sellMaxAttempts,
      maxUnroutableAttempts: cfg.sellMaxUnroutableAttempts,
      retryUntilTs: pending.retryUntilTs,
    });
    if (exhausted) {
      const stuck = state.positions[pending.mint];
      if (stuck) stuck.sellBlockedUntilTs = now + cfg.sellAbandonCooldownMs;
      await notifyCopyOpsAlert(
        cfg,
        `[ALERT][copy_ops] ${process.env.COPY_TRADER_APP_NAME || 'copy-trader'}: ` +
          `sell abandoned on ${pending.symbol} after ${attempts} attempts — orphan bag risk · ${failReason.slice(0, 80)}`,
      );
    }
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

  /** Boot grace: don't page leader_idle immediately; seed our buy from open positions. */
  opsMetrics.lastLeaderActivityTs = Date.now();
  for (const p of Object.values(state.positions)) {
    if (p.entryTs > opsMetrics.lastOurBuyTs) opsMetrics.lastOurBuyTs = p.entryTs;
  }

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
    minMirrorEntryUsd: cfg.minMirrorEntryUsd > 0 ? cfg.minMirrorEntryUsd : null,
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
    sellDelaySkipMaxDropPct: cfg.sellDelaySkipMaxDropPct,
    exitMode: cfg.exitMode,
    trail: usesTrailingExitPolicy(cfg)
      ? [
          `arm+${cfg.trailArmPct}%`,
          cfg.trailTpStepPct > 0
            ? `tpLadder+${cfg.trailTpStepPct}%x${cfg.trailTpSellFraction}`
            : cfg.trailTakeProfitPct > 0
              ? `tp${cfg.trailTakeProfitPct}%`
              : null,
          `giveback${cfg.trailGivebackPct}%x${cfg.trailTrailSellFraction}`,
          cfg.trailKillPct > 0 ? `kill-${cfg.trailKillPct}%` : null,
          cfg.trailTimeCapMs > 0 ? `cap${Math.round(cfg.trailTimeCapMs / 60_000)}m` : 'noCap',
        ]
          .filter(Boolean)
          .join(' ')
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
    fundingPartialClip: cfg.fundingPartialClipEnabled
      ? { fraction: cfg.fundingPartialClipFraction, minUsd: cfg.fundingPartialClipMinUsd }
      : null,
    isolated: true,
    leaderStream: cfg.leaderStreamEnabled,
    leaderIngressConcurrency: cfg.leaderIngressConcurrency,
  });

  const streamQueue: string[] = [];
  const streamSeen = new Set<string>();
  let leaderStream: LeaderWalletStream | null = null;
  const streamBackupPollMs = cfg.leaderStreamEnabled
    ? Math.max(cfg.pollIntervalMs, cfg.leaderStreamPollBackupMs)
    : cfg.pollIntervalMs;
  const streamFastPollMs = Math.max(1_000, cfg.leaderStreamFastPollMs);
  let streamHealthy = true;
  let streamMissStreak = 0;
  /** Consecutive silent_stream hits — only then briefly prefer logsSubscribe. */
  let streamSilentStreak = 0;
  let lastStreamWatchdogAlertMs = 0;
  let lastStreamWatchdogReason = '';
  let lastStreamForceReconnectMs = 0;
  /** Proactive TG when subscribed but zero notifies (do not wait for a missed swap). */
  let lastSilentSubscribeAlertMs = 0;

  if (cfg.leaderStreamEnabled) {
    const wsUrl = (cfg.leaderStreamWsUrl?.trim() || resolveLeaderStreamWsUrl() || '').trim();
    if (!wsUrl) {
      console.warn(
        '[copy-trader] LEADER_STREAM=1 but no WS URL (set COPY_TRADER_LEADER_STREAM_WS_URL or HELIUS_API_KEY)',
      );
    } else {
      leaderStream = new LeaderWalletStream(
        { wsUrl, leaderWallet: cfg.targetWallet },
        {
          onSignature: (sig) => {
            if (streamSeen.has(sig) || state.seenSignatures[sig]) return;
            streamSeen.add(sig);
            streamQueue.push(sig);
            if (streamQueue.length > 300) {
              const drop = streamQueue.splice(0, streamQueue.length - 300);
              for (const d of drop) streamSeen.delete(d);
            }
            if (streamSeen.size > 2_000) streamSeen.clear();
          },
          onStatus: (msg, detail) => {
            console.log('[copy-trader] leader-stream', msg, detail ?? '');
          },
        },
      );
      leaderStream.start();
      console.log('[copy-trader] leader stream started (Helius WS + watchdog)', {
        pollBackupMs: streamBackupPollMs,
        fastPollMs: streamFastPollMs,
        missThreshold: cfg.leaderStreamMissThreshold,
        wallet: cfg.targetWallet.slice(0, 8),
      });
    }
  }

  for (;;) {
    const now = Date.now();
    if (now - lastSolRefresh > 120_000) {
      await refreshSolPrice();
      lastSolRefresh = now;
    }

    if (streamQueue.length > 0) {
      const batch = streamQueue.splice(0, streamQueue.length).map((signature) => ({ signature }));
      try {
        const applied = await ingestLeaderSignatureRows(cfg, state, batch, 'stream');
        // Allow stream re-queue if getTransaction failed (sig not yet in seenSignatures).
        for (const { signature } of batch) {
          if (!state.seenSignatures[signature]) streamSeen.delete(signature);
        }
        if (applied > 0) {
          writeCopyTraderState(cfg.statePath, state);
          await processPendingSells(cfg, state);
          console.log('[copy-trader] stream ingress applied', applied);
        }
      } catch (err) {
        for (const { signature } of batch) streamSeen.delete(signature);
        console.warn('[copy-trader] stream ingress error', (err as Error).message);
      }
    }

    // Mid-tick: if WS drops, degrade to fast poll immediately (don't wait 5s).
    // Skip forceReconnect spam during the first subscribe handshake.
    if (cfg.leaderStreamEnabled) {
      const healthNow = leaderStream?.getHealth() ?? null;
      /** Yellow stream_silent spam removed — serious stream_dead is in ops-watch (15m). */
      if (
        healthNow?.subscribed &&
        healthNow.notifyCount === 0 &&
        healthNow.lastSubscribedAtMs > 0 &&
        now - healthNow.lastSubscribedAtMs >= 120_000 &&
        now - lastSilentSubscribeAlertMs >= 120_000
      ) {
        lastSilentSubscribeAlertMs = now;
        console.warn('[copy-trader] stream_silent (no TG)', {
          ageSec: Math.round((now - healthNow.lastSubscribedAtMs) / 1000),
          mode: healthNow.mode,
          reconnectCount: healthNow.reconnectCount,
        });
      }

      const linkDecision = evaluateStreamWatchdog({
        nowMs: now,
        enabled: true,
        health: healthNow,
        pollMissesThisCycle: 0,
        missStreak: streamMissStreak,
        missThreshold: cfg.leaderStreamMissThreshold,
        silentStreak: streamSilentStreak,
        updateMissStreak: false,
      });
      streamSilentStreak = linkDecision.nextSilentStreak;
      if (!linkDecision.healthy) {
        if (
          linkDecision.forceReconnect &&
          leaderStream &&
          now - lastStreamForceReconnectMs >= 10_000
        ) {
          lastStreamForceReconnectMs = now;
          console.warn('[copy-trader] stream watchdog force reconnect', {
            reason: linkDecision.reason,
            preferLogsSubscribe: linkDecision.preferLogsSubscribe === true,
            health: leaderStream.getHealth(),
          });
          leaderStream.forceReconnect({
            preferLogsSubscribe: linkDecision.preferLogsSubscribe === true,
            logsSubscribeForMs: 90_000,
          });
        }
        if (streamHealthy || linkDecision.reason !== lastStreamWatchdogReason) {
          // Boot: connected=false is expected for ~1s — don't spam until we opened once.
          if (linkDecision.reason !== 'disconnected' || (leaderStream?.getHealth().lastOpenAtMs ?? 0) > 0) {
            console.warn('[copy-trader] stream watchdog link', {
              reason: linkDecision.reason,
              health: leaderStream?.getHealth() ?? null,
            });
          }
          lastStreamWatchdogReason = linkDecision.reason;
          if (copyTraderStreamNoiseAlertsEnabled()) {
            const everOpened = (leaderStream?.getHealth().lastOpenAtMs ?? 0) > 0;
            if (
              streamHealthy &&
              everOpened &&
              (cfg.leaderStreamWatchdogAlertCooldownMs === 0 ||
                now - lastStreamWatchdogAlertMs >= cfg.leaderStreamWatchdogAlertCooldownMs)
            ) {
              lastStreamWatchdogAlertMs = now;
              const app = process.env.COPY_TRADER_APP_NAME || 'copy-trader';
              void notifyCopyTraderTelegram(
                cfg,
                `[ALERT][stream_watchdog] ${app}: degraded (${linkDecision.reason}) → fast poll ${streamFastPollMs}ms` +
                  (linkDecision.forceReconnect ? ' + reconnect' : ''),
              );
            }
          }
        }
        streamHealthy = false;
      } else if (!streamHealthy && streamMissStreak === 0) {
        // Link recovered between polls (reconnect finished + subscribed).
        streamHealthy = true;
        if (lastStreamWatchdogReason !== 'ok') {
          console.log('[copy-trader] stream watchdog recovered', {
            reason: 'ok',
            health: leaderStream?.getHealth() ?? null,
          });
          lastStreamWatchdogReason = 'ok';
        }
      }
    }

    const effectivePollMs =
      cfg.leaderStreamEnabled && (!streamHealthy || !leaderStream)
        ? Math.min(streamBackupPollMs, streamFastPollMs)
        : streamBackupPollMs;

    if (now - lastPoll >= effectivePollMs) {
      let discovered: string[] = [];
      let pollApplied = 0;
      try {
        const pollResult = await pollLeaderWallet(cfg, state);
        discovered = pollResult.discovered;
        pollApplied = pollResult.applied;
        gcSeenSignatures(state, 48 * 3600_000);
        reconcileOscarHandoffClosedFromDisk(cfg, state);
        writeCopyTraderState(cfg.statePath, state);
      } catch (err) {
        console.warn('[copy-trader] poll error', (err as Error).message);
      }
      lastPoll = now;

      if (cfg.leaderStreamEnabled) {
        // Only count cycles where poll applied a swap the stream never queued.
        // Raw discovered includes non-swaps that tokenAccounts stream ignores.
        const pollMisses = discovered.filter((sig) => !streamSeen.has(sig)).length;
        const swapMisses = pollApplied > 0 && pollMisses > 0 ? 1 : 0;
        const decision = evaluateStreamWatchdog({
          nowMs: now,
          enabled: true,
          health: leaderStream?.getHealth() ?? null,
          pollMissesThisCycle: swapMisses,
          missStreak: streamMissStreak,
          missThreshold: cfg.leaderStreamMissThreshold,
          silentStreak: streamSilentStreak,
        });
        streamMissStreak = decision.nextMissStreak;
        streamSilentStreak = decision.nextSilentStreak;
        const wasHealthy: boolean = streamHealthy;
        streamHealthy = decision.healthy;

        if (decision.forceReconnect && leaderStream && now - lastStreamForceReconnectMs >= 10_000) {
          lastStreamForceReconnectMs = now;
          console.warn('[copy-trader] stream watchdog force reconnect', {
            reason: decision.reason,
            pollMisses,
            swapMisses,
            silentStreak: streamSilentStreak,
            preferLogsSubscribe: decision.preferLogsSubscribe === true,
            health: leaderStream.getHealth(),
          });
          leaderStream.forceReconnect({
            preferLogsSubscribe: decision.preferLogsSubscribe === true,
            /** Brief logs hold only — then retry paid transactionSubscribe. */
            logsSubscribeForMs: 90_000,
          });
        }

        if (wasHealthy !== streamHealthy || decision.reason !== lastStreamWatchdogReason) {
          console.log('[copy-trader] stream watchdog', {
            healthy: streamHealthy,
            reason: decision.reason,
            useFastPoll: decision.useFastPoll,
            pollMisses,
            swapMisses,
            notifyCount: leaderStream?.getHealth().notifyCount ?? 0,
            mode: leaderStream?.getHealth().mode ?? null,
            missStreak: streamMissStreak,
            silentStreak: streamSilentStreak,
            effectivePollMs: streamHealthy ? streamBackupPollMs : streamFastPollMs,
          });
          lastStreamWatchdogReason = decision.reason;
          /** Yellow poll_miss / recovered — logs only unless STREAM_NOISE=1. */
          if (copyTraderStreamNoiseAlertsEnabled()) {
            const cooldown = cfg.leaderStreamWatchdogAlertCooldownMs;
            if (cooldown === 0 || now - lastStreamWatchdogAlertMs >= cooldown) {
              lastStreamWatchdogAlertMs = now;
              const app = process.env.COPY_TRADER_APP_NAME || 'copy-trader';
              if (!streamHealthy) {
                void notifyCopyTraderTelegram(
                  cfg,
                  `[ALERT][stream_watchdog] ${app}: degraded (${decision.reason}) → fast poll ${streamFastPollMs}ms` +
                    (decision.forceReconnect ? ' + reconnect' : ''),
                );
              } else if (wasHealthy === false) {
                void notifyCopyTraderTelegram(
                  cfg,
                  `[OK][stream_watchdog] ${app}: recovered → backup poll ${streamBackupPollMs}ms`,
                );
              }
            }
          }
        }
      }

      // Flush due sells in the same tick we discovered the leader exit — do not
      // wait for the next loop after buys/reconcile burned the budget.
      try {
        await processPendingSells(cfg, state);
      } catch (err) {
        console.warn('[copy-trader] post-poll sell error', (err as Error).message);
      }
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

    if (cfg.volFadeCheckIntervalMs > 0) {
      try {
        const faded = await processVolFadeExits(
          cfg,
          state,
          {
            fetchMarketSnapshot: async (mint) => {
              const ctx = await fetchCopyEntryContext(mint);
              return {
                volume5mUsd: ctx?.volume5mUsd ?? null,
                volume1hUsd: ctx?.volume1hUsd ?? null,
                marketCapUsd: ctx?.marketCapUsd ?? null,
              };
            },
          },
          now,
        );
        for (const row of faded) {
          if (row.accelerated) continue;
          appendCopyEvent(cfg, {
            kind: 'vol_fade_exit_scheduled',
            mint: row.mint,
            symbol: row.symbol,
            reason: row.reason,
            volume5mUsd: Math.round(row.volume5mUsd),
            entryVolume5mUsd:
              row.entryVolume5mUsd != null ? Math.round(row.entryVolume5mUsd) : null,
            medianVolume5mUsd:
              row.medianVolume5mUsd != null ? Math.round(row.medianVolume5mUsd) : null,
            weakCount: row.weakCount,
            sampleCount: row.sampleCount,
            volFadeMinVolume5mUsd: cfg.volFadeMinVolume5mUsd,
            volFadeDropPct: cfg.volFadeDropPct,
            volFadeSampleWindow: cfg.volFadeSampleWindow,
            volFadeMinWeakSamples: cfg.volFadeMinWeakSamples,
          });
        }
        if (faded.length > 0) console.log('[copy-trader] vol-fade exits scheduled', faded.length);
      } catch (err) {
        console.warn('[copy-trader] vol-fade exit error', (err as Error).message);
      }
    }

    if (mirrorsLeaderSells(cfg) && cfg.mirrorHoldCapMs > 0) {
      try {
        const timed = await processMirrorHoldCapExits(
          cfg,
          state,
          {
            fetchMarketSnapshot: async (mint) => {
              const ctx = await fetchCopyEntryContext(mint);
              return {
                volume5mUsd: ctx?.volume5mUsd ?? null,
                volume1hUsd: ctx?.volume1hUsd ?? null,
                marketCapUsd: ctx?.marketCapUsd ?? null,
              };
            },
          },
          now,
        );
        for (const row of timed) {
          if (row.accelerated) continue;
          appendCopyEvent(cfg, {
            kind: 'mirror_hold_cap_scheduled',
            mint: row.mint,
            symbol: row.symbol,
            heldSec: Math.round(row.heldMs / 1000),
            reason: row.reason,
            mirrorHoldCapMs: cfg.mirrorHoldCapMs,
            mirrorHoldCapVolOkMs: cfg.mirrorHoldCapVolOkMs > 0 ? cfg.mirrorHoldCapVolOkMs : null,
          });
        }
        if (timed.length > 0) console.log('[copy-trader] mirror hold-cap exits scheduled', timed.length);
      } catch (err) {
        console.warn('[copy-trader] mirror hold-cap error', (err as Error).message);
      }
    }

    if (mirrorsLeaderSells(cfg) && cfg.mirrorEarlyTpGainPct > 0) {
      try {
        const peels = await processMirrorEarlyTpExits(
          cfg,
          state,
          {
            resolvePriceUsd: async (mint) => {
              const dex = await fetchDexInfo(mint, getSolUsd());
              const resolved = await resolveCurrentPrice(mint, dex?.priceUsd ?? 0);
              return resolved.priceUsd;
            },
          },
          now,
        );
        for (const row of peels) {
          appendCopyEvent(cfg, {
            kind: 'mirror_early_tp_scheduled',
            mint: row.mint,
            symbol: row.symbol,
            gainPct: row.gainPct,
            sellFraction: row.sellFraction,
            entryPriceUsd: row.entryPriceUsd,
            priceUsd: row.priceUsd,
            mirrorEarlyTpGainPct: cfg.mirrorEarlyTpGainPct,
          });
        }
        if (peels.length > 0) console.log('[copy-trader] mirror early TP scheduled', peels.length);
      } catch (err) {
        console.warn('[copy-trader] mirror early TP error', (err as Error).message);
      }
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
      // Sells before buys: a just-discovered leader exit must not wait behind an
      // entry quote round-trip on another mint.
      await processPendingSells(cfg, state);
      await processPendingBuys(cfg, state);
      /** Flat-tail is leader-follow cleanup — not for trail_runner. */
      if (!usesTrailingExitPolicy(cfg)) {
        const tailSweeps = await scheduleLeaderFlatTailSweeps(cfg, state);
        if (tailSweeps > 0) {
          console.log('[copy-trader] leader-flat tail sweep scheduled', tailSweeps);
        }
      }
      maybeSummarizeShadowSelect(cfg);
      writeCopyTraderState(cfg.statePath, state);
      await tickCopyOpsWatch(cfg, state, leaderStream, now);
    } catch (err) {
      console.warn('[copy-trader] tick error', (err as Error).message);
    }

    await sleep(cfg.tickIntervalMs);
  }
}
