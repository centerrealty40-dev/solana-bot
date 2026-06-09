import type { TxJsonParsed } from '../parser/rpc-http.js';
import { decodeAllowlistedDexSwapForWallet } from '../parser/allowlisted-dex-swap.js';
import { decodePumpfunSwap, PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { SwapInsert } from '../parser/pumpfun.js';
import {
  applyLeaderSwapToLedger,
  bootstrapLeaderPreSellBalance,
  leaderPreBalanceRaw,
} from './leader-ledger.js';
import { fetchParsedTransaction, fetchWalletSignatures, type SignatureRow } from '../copytrader/rpc.js';
import { fetchWalletMintBalanceRaw } from '../copytrader/rpc.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { fetchMintPoolAddress } from '../pumpswap-combo/watchlist.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { executeFollowBuy } from './executor.js';
import { appendFollowEvent } from './journal.js';
import {
  findFollowPosition,
  newFollowId,
  openFollowPositionsCount,
  isFollowLossCooldownActive,
  writeFollowState,
  type FollowState,
} from './state.js';
import type { PendingFollowBuy } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function decodeSwapForWallet(tx: TxJsonParsed, wallet: string, solUsd: number): SwapInsert | null {
  const pf = decodePumpfunSwap(tx, PUMP_FUN_PROGRAM_ID, solUsd).find((s) => s.wallet === wallet);
  if (pf) return pf;
  return decodeAllowlistedDexSwapForWallet(tx, wallet, solUsd);
}

function scheduleFollowBuy(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  args: {
    mint: string;
    symbol: string;
    kind: 'entry' | 'add';
    leaderSignature: string;
    leaderPriceUsd: number;
    leaderBuyUsd: number;
  },
): void {
  const now = Date.now();
  const dueTs = now + cfg.buyDelayMs;
  const pending: PendingFollowBuy = {
    id: newFollowId('fb'),
    mint: args.mint,
    symbol: args.symbol,
    kind: args.kind,
    leaderSignature: args.leaderSignature,
    leaderPriceUsd: args.leaderPriceUsd,
    leaderBuyUsd: args.leaderBuyUsd,
    dueTs,
    retryUntilTs: dueTs + cfg.buyRetryWindowMs,
  };
  state.pendingBuys.push(pending);
  appendFollowEvent(cfg, {
    kind: args.kind === 'add' ? 'leader_add_scheduled' : 'leader_buy_scheduled',
    mint: args.mint,
    symbol: args.symbol,
    leaderSignature: args.leaderSignature,
    leaderPriceUsd: args.leaderPriceUsd,
    leaderBuyUsd: args.leaderBuyUsd,
    buyDueTs: dueTs,
    buyDelayMs: cfg.buyDelayMs,
    retryUntilTs: pending.retryUntilTs,
    sizeUsd: cfg.legUsd,
    targetWallet: cfg.targetWallet,
  });
}

async function onLeaderBuy(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  swap: SwapInsert,
  symbol: string,
  row: SignatureRow,
  preLeaderRaw: bigint,
): Promise<void> {
  const mint = swap.baseMint;
  if (swap.amountUsd < cfg.minLeaderBuyUsd) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'min_leader_buy_usd',
      mint,
      leaderBuyUsd: swap.amountUsd,
      minLeaderBuyUsd: cfg.minLeaderBuyUsd,
      leaderSignature: row.signature,
    });
    return;
  }

  const existing = findFollowPosition(state, mint);

  if (existing) {
    if (existing.legs.length >= cfg.maxBuyLegs) {
      appendFollowEvent(cfg, {
        kind: 'leader_add_ignored',
        reason: 'max_buy_legs',
        mint,
        legs: existing.legs.length,
        leaderSignature: row.signature,
      });
      return;
    }
    scheduleFollowBuy(cfg, state, {
      mint,
      symbol,
      kind: 'add',
      leaderSignature: row.signature,
      leaderPriceUsd: swap.priceUsd,
      leaderBuyUsd: swap.amountUsd,
    });
    return;
  }

  if (preLeaderRaw > 0n) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'missed_entry_leader_already_in',
      mint,
      leaderSignature: row.signature,
    });
    return;
  }

  if (cfg.maxOpenPositions > 0 && openFollowPositionsCount(state) >= cfg.maxOpenPositions) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'max_open_positions',
      mint,
      leaderSignature: row.signature,
    });
    return;
  }

  if (isFollowLossCooldownActive(state, mint, Date.now())) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'loss_cooldown',
      mint,
      leaderSignature: row.signature,
    });
    return;
  }

  scheduleFollowBuy(cfg, state, {
    mint,
    symbol,
    kind: 'entry',
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
  });
}

/** Leader sells update ledger only — exits are price-ladder, not reactive copy. */
async function onLeaderSell(
  cfg: PumpswapComboFollowConfig,
  _state: FollowState,
  swap: SwapInsert,
  row: SignatureRow,
  preLeaderRaw: bigint,
): Promise<void> {
  appendFollowEvent(cfg, {
    kind: 'leader_sell_observed',
    mint: swap.baseMint,
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderSellUsd: swap.amountUsd,
    leaderPreBalanceRaw: preLeaderRaw.toString(),
    note: 'no_mirror_sell',
  });
}

async function executePendingBuy(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  pending: PendingFollowBuy,
): Promise<void> {
  const pool = await fetchMintPoolAddress(pending.mint);
  if (!pool) {
    appendFollowEvent(cfg, {
      kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
      reason: 'no_pumpswap_pool',
      mint: pending.mint,
      leaderSignature: pending.leaderSignature,
    });
    return;
  }

  const existing = findFollowPosition(state, pending.mint);

  const buy = await executeFollowBuy({
    cfg,
    mint: pending.mint,
    symbol: pending.symbol,
    poolAddress: pool,
    leaderPriceUsd: pending.leaderPriceUsd,
    intent: pending.kind === 'add' ? 'add' : 'probe',
    leaderSignature: pending.leaderSignature,
  });

  if (!buy.ok || !(buy.fillPriceUsd && buy.fillPriceUsd > 0)) {
    appendFollowEvent(cfg, {
      kind: pending.kind === 'add' ? 'add_fail' : 'buy_fail',
      mint: pending.mint,
      symbol: pending.symbol,
      leaderSignature: pending.leaderSignature,
      reason: buy.reason ?? 'fill_failed',
    });
    return;
  }

  const nowMs = Date.now();
  const leg = {
    ts: nowMs,
    usd: buy.usdAtMarket ?? cfg.legUsd,
    fillPriceUsd: buy.fillPriceUsd,
    txSignature: buy.txSignature,
  };

  if (existing) {
    existing.legs.push(leg);
    if (buy.fillPriceUsd > existing.botPeakUsd) existing.botPeakUsd = buy.fillPriceUsd;
    appendFollowEvent(cfg, {
      kind: 'add_ok',
      mode: cfg.executionMode,
      mint: pending.mint,
      symbol: pending.symbol,
      leaderSignature: pending.leaderSignature,
      legUsd: leg.usd,
      fillPriceUsd: buy.fillPriceUsd,
      legs: existing.legs.length,
    });
  } else {
    state.positions.push({
      mint: pending.mint,
      symbol: pending.symbol,
      poolAddress: pool,
      openedAt: nowMs,
      legs: [leg],
      botPeakUsd: Math.max(pending.leaderPriceUsd, buy.fillPriceUsd),
      rungsTaken: [],
      leaderWallet: cfg.targetWallet,
      remainingFrac: 1,
    });
    appendFollowEvent(cfg, {
      kind: 'buy_ok',
      mode: cfg.executionMode,
      mint: pending.mint,
      symbol: pending.symbol,
      leaderSignature: pending.leaderSignature,
      intent: 'mirror_entry',
      legUsd: leg.usd,
      fillPriceUsd: buy.fillPriceUsd,
      leaderPriceUsd: pending.leaderPriceUsd,
      leaderBuyUsd: pending.leaderBuyUsd,
    });
  }
}

export async function processPendingFollowBuys(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<void> {
  const now = Date.now();
  const due = state.pendingBuys.filter((p) => p.dueTs <= now);
  if (!due.length) return;

  for (const pending of due) {
    const idx = state.pendingBuys.indexOf(pending);
    if (idx < 0) continue;

    if (now > pending.retryUntilTs) {
      state.pendingBuys.splice(idx, 1);
      appendFollowEvent(cfg, {
        kind: pending.kind === 'add' ? 'add_expired' : 'buy_expired',
        mint: pending.mint,
        leaderSignature: pending.leaderSignature,
      });
      continue;
    }

    if (state.halted) {
      appendFollowEvent(cfg, {
        kind: 'buy_deferred',
        reason: 'portfolio_halted',
        mint: pending.mint,
      });
      continue;
    }

    const legsBefore = findFollowPosition(state, pending.mint)?.legs.length ?? 0;
    await executePendingBuy(cfg, state, pending);
    const stillThere = state.pendingBuys.indexOf(pending);
    if (stillThere >= 0) {
      const pos = findFollowPosition(state, pending.mint);
      const filled =
        pending.kind === 'entry' ? pos != null : (pos?.legs.length ?? 0) > legsBefore;
      if (filled) {
        state.pendingBuys.splice(stillThere, 1);
      } else {
        pending.dueTs = now + 5000;
      }
    }
    writeFollowState(cfg, state);
    await sleep(150);
  }
}

export async function pollLeaderAndScheduleBuys(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<{ newSwaps: number; rpcFailed: boolean }> {
  const { rows, rpcFailed } = await fetchWalletSignatures(
    cfg.rpcUrl,
    cfg.targetWallet,
    cfg.signatureLimit,
  );
  if (rpcFailed) return { newSwaps: 0, rpcFailed: true };
  if (!rows.length) return { newSwaps: 0, rpcFailed: false };

  const latest = rows[0]!.signature;
  const prev = state.lastSignature;
  if (!prev) {
    state.lastSignature = latest;
    for (const row of rows) state.seenSignatures[row.signature] = Date.now();
    writeFollowState(cfg, state);
    return { newSwaps: 0, rpcFailed: false };
  }

  const newRows: SignatureRow[] = [];
  for (const row of rows) {
    if (row.signature === prev) break;
    if (state.seenSignatures[row.signature]) continue;
    newRows.push(row);
  }
  state.lastSignature = latest;
  newRows.reverse();

  let newSwaps = 0;
  for (const row of newRows) {
    state.seenSignatures[row.signature] = Date.now();
    const raw = await fetchParsedTransaction(cfg.rpcUrl, row.signature);
    if (!raw) continue;
    const tx = raw as TxJsonParsed;
    const swap = decodeSwapForWallet(tx, cfg.targetWallet, getSolUsd());
    if (!swap || swap.priceUsd <= 0) continue;

    newSwaps++;
    const symbol = swap.baseMint.slice(0, 6);
    let preLeaderRaw = leaderPreBalanceRaw(state, swap.baseMint);
    if (swap.side === 'sell' && preLeaderRaw === 0n) {
      const post = await fetchWalletMintBalanceRaw(cfg.rpcUrl, cfg.targetWallet, swap.baseMint);
      preLeaderRaw = bootstrapLeaderPreSellBalance(post, swap.baseAmountRaw);
    }

    if (swap.side === 'buy') {
      await onLeaderBuy(cfg, state, swap, symbol, row, preLeaderRaw);
    } else {
      await onLeaderSell(cfg, state, swap, row, preLeaderRaw);
    }
    applyLeaderSwapToLedger(state, swap.baseMint, swap.side, swap.baseAmountRaw);
    await sleep(120);
  }

  if (newRows.length) writeFollowState(cfg, state);
  return { newSwaps, rpcFailed: false };
}
