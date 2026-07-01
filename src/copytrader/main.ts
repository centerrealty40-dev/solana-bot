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
import {
  closePositionForMint,
  ensurePositionFromWallet,
  fetchExecutionWalletBalanceRaw,
  reconcileGhostPositions,
  refreshPositionFromWallet,
  syncPositionFromWallet,
  walletNotionalUsdFromRaw,
  accumulateCopyTokenRaw,
  copySellableTokenRaw,
  copyTrackedTokenRaw,
} from './position-reconcile.js';
import { checkCopyBuyOscarDupGuard, type CopyBuyOscarDupGuardVerdict } from './oscar-position-guard.js';
import { checkCopySpareCapitalGate } from './spare-capital-gate.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    copyPosition?: CopyPosition | null;
    walletMintRaw?: bigint;
    priceUsd?: number;
  },
): CopyBuyOscarDupGuardVerdict & { skip: true } | null {
  const verdict = checkCopyBuyOscarDupGuard({
    cfg,
    mint: args.mint,
    copyPosition: args.copyPosition,
    walletMintRaw: args.walletMintRaw,
    priceUsd: args.priceUsd,
    statePath: cfg.statePath,
  });
  return verdict.skip ? verdict : null;
}

let lastPollRpcFailLogMs = 0;
const POLL_RPC_FAIL_LOG_MS = 60_000;

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

async function resolveCurrentPrice(mint: string, dexPrice: number): Promise<number> {
  if (dexPrice > 0) return dexPrice;
  const jup = await fetchJupiterTokenUsdPrice(mint);
  return jup ?? 0;
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

  if (existing) {
    if (hasPendingBuyForMint(state, mint)) return;
    const dupOnAdd = oscarDupGuardBlocksBuy(cfg, {
      mint,
      copyPosition: existing,
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
  const dupOnEntry = oscarDupGuardBlocksBuy(cfg, {
    mint,
    copyPosition: existing,
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

  if (usesDipOnlyEntry(cfg)) {
    const dex = await fetchDexInfo(mint, getSolUsd());
    const mcap = dex?.marketCap && dex.marketCap > 0 ? dex.marketCap : undefined;
    const targetUsd = entryTargetUsd(cfg, mcap);
    await schedulePendingBuy(cfg, state, {
      mint,
      symbol,
      kind: 'entry',
      sizeUsd: entryDipSizeUsd(cfg, mcap),
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
  const targetUsd = entryTargetUsd(cfg, mcap);
  const probeUsd = usesSplitEntryProbe(cfg) ? entryProbeSizeUsd(cfg, mcap) : targetUsd;
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
  const dipUsd = entryDipSizeUsd(cfg, mcap);
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
  const pos = state.positions[mint];
  if (pos?.oscarPromotedAt) {
    appendCopyEvent(cfg, {
      kind: 'leader_sell_ignored',
      reason: 'oscar_promoted_handoff',
      mint,
      leaderSignature: row.signature,
      oscarPromotedAt: pos.oscarPromotedAt,
    });
    return;
  }
  const sellFrac = leaderSellFraction(preLeaderRaw, swap.baseAmountRaw);

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

  const walletBal = await fetchExecutionWalletBalanceRaw(cfg, mint);
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
    syncEntryPendingSizing(cfg, pending, dex?.marketCap);
    let currentPrice = await resolveCurrentPrice(pending.mint, dex?.priceUsd ?? 0);
    let entryPriceSource: 'jupiter_quote' | 'dex' | undefined;
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
          entryDipPriceSource: entryPriceSource ?? null,
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
      const walletBalForGuard = await fetchExecutionWalletBalanceRaw(cfg, pending.mint);
      const dupGuard = oscarDupGuardBlocksBuy(cfg, {
        mint: pending.mint,
        copyPosition: existing,
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
      if (noteBuyDefer(state, pending.id, now, cfg)) {
        appendCopyEvent(cfg, {
          kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
          mint: pending.mint,
          symbol: pending.symbol,
          leaderSignature: pending.leaderSignature,
          reason: exec.reason ?? 'execution_failed',
          retryUntilTs: pending.retryUntilTs,
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
    const fillRaw =
      exec.tokenRaw ??
      (currentPrice > 0
        ? BigInt(Math.floor((pending.sizeUsd / currentPrice) * 1_000_000)).toString()
        : undefined);
    if ((pending.kind === 'entry' && pending.entryLeg !== 'dip') || !existing) {
      const tokenRaw = cfg.sharedOscarWallet
        ? fillRaw
        : walletBal > 0n
          ? walletBal.toString()
          : fillRaw;
      const sizeUsd =
        !cfg.sharedOscarWallet && walletBal > 0n && currentPrice > 0
          ? walletNotionalUsdFromRaw(walletBal, currentPrice)
          : pending.sizeUsd;
      state.positions[pending.mint] = {
        mint: pending.mint,
        symbol: pending.symbol,
        positionSource: COPY_LEADER_POSITION_SOURCE,
        entryTs: Date.now(),
        entryPriceUsd: currentPrice,
        sizeUsd,
        tokenRaw,
        addCount: 0,
        entryDeployedCostUsd: pending.sizeUsd,
        entryTargetUsd: pending.entryTargetUsd ?? entryTargetUsd(cfg, pending.entryMcapUsd),
        entryMcapUsd: pending.entryMcapUsd,
        leaderWallet: cfg.targetWallet,
        leaderEntrySig: pending.leaderSignature,
        ourEntrySig: exec.signature,
      };
    } else {
      const prev = existing;
      const newAvg =
        prev.sizeUsd > 0 && currentPrice > 0
          ? (prev.entryPriceUsd * prev.sizeUsd + currentPrice * pending.sizeUsd) /
            (prev.sizeUsd + pending.sizeUsd)
          : currentPrice;
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
        syncPositionFromWallet(prev, copyTrackedTokenRaw(prev), currentPrice, cfg);
      } else if (walletBal > 0n) {
        syncPositionFromWallet(prev, walletBal, currentPrice, cfg);
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
          (currentPrice > 0
            ? BigInt(Math.floor((pending.sizeUsd / currentPrice) * 1_000_000)).toString()
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
  const due = state.pendingSells.filter((p) => p.dueTs <= now);
  if (due.length === 0) return;

  for (const pending of due) {
    let pos = state.positions[pending.mint];
    if (pos?.oscarPromotedAt) {
      removePendingSellById(state, pending.id);
      continue;
    }

    const dex = await fetchDexInfo(pending.mint, getSolUsd());
    const exitPrice = await resolveCurrentPrice(pending.mint, dex?.priceUsd ?? 0);
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

  try {
    const cleared = await reconcileGhostPositions(cfg, state);
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
    addMirror: 'proportional_to_leader',
    maxPositionUsd: cfg.maxPositionUsd > 0 ? cfg.maxPositionUsd : 'unlimited',
    maxAddsPerMint: cfg.maxAddsPerMint > 0 ? cfg.maxAddsPerMint : 'unlimited',
    maxOpenPositions: cfg.maxOpenPositions > 0 ? cfg.maxOpenPositions : 'unlimited',
    buyDelayMin: Math.round(cfg.buyDelayMs / 60_000),
    probeBuyDelaySec: Math.round(cfg.entryProbeBuyDelayMs / 1000),
    buyPriceMaxPremiumPct: cfg.buyPriceMaxPremiumPct,
    buyRetryWindowMin: Math.round(cfg.buyRetryWindowMs / 60_000),
    sellRetryWindowMin: Math.round(cfg.sellRetryWindowMs / 60_000),
    sellRetryIntervalSec: Math.round(cfg.sellRetryIntervalMs / 1000),
    sellDelaySec: `${Math.round(cfg.sellDelayMinMs / 1000)}-${Math.round(cfg.sellDelayMaxMs / 1000)}`,
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
        writeCopyTraderState(cfg.statePath, state);
      } catch (err) {
        console.warn('[copy-trader] poll error', (err as Error).message);
      }
      lastPoll = now;
    }

    if (now - lastReconcile >= 60_000) {
      try {
        const cleared = await reconcileGhostPositions(cfg, state);
        if (cleared > 0) console.log('[copy-trader] cleared ghost positions', cleared);
      } catch (err) {
        console.warn('[copy-trader] reconcile error', (err as Error).message);
      }
      lastReconcile = now;
    }

    try {
      await processPendingBuys(cfg, state);
      await processPendingSells(cfg, state);
      const tailSweeps = await scheduleLeaderFlatTailSweeps(cfg, state);
      if (tailSweeps > 0) {
        console.log('[copy-trader] leader-flat tail sweep scheduled', tailSweeps);
      }
      writeCopyTraderState(cfg.statePath, state);
    } catch (err) {
      console.warn('[copy-trader] tick error', (err as Error).message);
    }

    await sleep(cfg.tickIntervalMs);
  }
}
