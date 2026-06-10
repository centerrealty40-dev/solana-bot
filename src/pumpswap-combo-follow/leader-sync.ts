import type { TxJsonParsed } from '../parser/rpc-http.js';
import { decodeAllowlistedDexSwapForWallet, extractPumpSwapPoolFromTx } from '../parser/allowlisted-dex-swap.js';
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
import type { PumpswapComboFollowConfig } from './config.js';
import { executeFollowBuy } from './executor.js';
import { appendFollowEvent } from './journal.js';
import { resolveFollowPoolAddress } from './pool-resolve.js';
import {
  findFollowPosition,
  newFollowId,
  openFollowPositionsCount,
  isFollowLossCooldownActive,
  readFollowState,
  writeFollowState,
  type FollowState,
} from './state.js';
import { initFollowWaveBState } from './follow-wave-b-state.js';
import { checkFlowEntryGate } from './entry-gate.js';
import { blocksMissedEntryLeaderAlreadyIn } from './entry-eligibility.js';
import type { PendingFollowBuy } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function decodeSwapForWallet(tx: TxJsonParsed, wallet: string, solUsd: number): SwapInsert | null {
  const pf = decodePumpfunSwap(tx, PUMP_FUN_PROGRAM_ID, solUsd).find((s) => s.wallet === wallet);
  if (pf) return pf;
  return decodeAllowlistedDexSwapForWallet(tx, wallet, solUsd);
}

function leaderObservedMs(row: SignatureRow): number | undefined {
  const bt = row.blockTime;
  return typeof bt === 'number' && bt > 0 ? bt * 1000 : undefined;
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
    leaderBlockTimeSec?: number;
    poolAddress?: string;
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
    leaderBlockTimeSec: args.leaderBlockTimeSec,
    poolAddress: args.poolAddress,
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
    leaderBlockTimeSec: args.leaderBlockTimeSec ?? null,
    buyDueTs: dueTs,
    buyDelayMs: cfg.buyDelayMs,
    retryUntilTs: pending.retryUntilTs,
    sizeUsd: cfg.entryUsd,
    targetWallet: cfg.targetWallet,
    poolAddress: args.poolAddress ?? null,
  });
}

async function onLeaderBuy(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  swap: SwapInsert,
  symbol: string,
  row: SignatureRow,
  preLeaderRaw: bigint,
  leaderTx?: TxJsonParsed,
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

  if (!existing && cfg.maxLeaderFirstBuyUsd > 0 && swap.amountUsd > cfg.maxLeaderFirstBuyUsd) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'max_leader_first_buy_usd',
      mint,
      leaderBuyUsd: swap.amountUsd,
      maxLeaderFirstBuyUsd: cfg.maxLeaderFirstBuyUsd,
      leaderSignature: row.signature,
    });
    return;
  }

  if (existing) {
    if (!cfg.mirrorLeaderAdds) {
      appendFollowEvent(cfg, {
        kind: 'leader_add_ignored',
        reason:
          cfg.exitPolicy === 'oscar_wave_b' || cfg.dcaLevels.length > 0
            ? 'oscar_price_dca_only'
            : 'no_mirror_adds',
        mint,
        leaderSignature: row.signature,
        note:
          cfg.exitPolicy === 'oscar_wave_b' || cfg.dcaLevels.length > 0
            ? 'price front-run DCA only, not leader mirror'
            : undefined,
      });
      return;
    }
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
      leaderBlockTimeSec: row.blockTime,
      poolAddress: leaderTx ? extractPumpSwapPoolFromTx(leaderTx) ?? undefined : undefined,
    });
    return;
  }

  if (blocksMissedEntryLeaderAlreadyIn({
    preLeaderRaw,
    hasOurPosition: Boolean(existing),
    allowLateEntryOnLeaderAdd: cfg.allowLateEntryOnLeaderAdd,
  })) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'missed_entry_leader_already_in',
      mint,
      leaderSignature: row.signature,
    });
    return;
  }

  if (preLeaderRaw > 0n) {
    appendFollowEvent(cfg, {
      kind: 'late_entry_on_leader_add',
      mint,
      leaderSignature: row.signature,
      leaderBuyUsd: swap.amountUsd,
      leaderPreBalanceRaw: preLeaderRaw.toString(),
    });
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

  const poolAddress = leaderTx ? extractPumpSwapPoolFromTx(leaderTx) ?? undefined : undefined;
  const gate = await checkFlowEntryGate(cfg, {
    pool: poolAddress,
    mint,
    leaderSignature: row.signature,
    leaderTsSec: row.blockTime,
  });
  if (!gate.pass) {
    appendFollowEvent(cfg, {
      kind: 'leader_buy_ignored',
      reason: 'flow_entry_gate',
      gateReason: gate.reason ?? 'unknown',
      mint,
      leaderSignature: row.signature,
      poolAddress: poolAddress ?? null,
      extSellUsd: gate.extSell?.usd ?? null,
      extSellLagSec: gate.extSell?.lagSec ?? null,
      extSellSignature: gate.extSell?.signature ?? null,
      flowGateMinExtSellUsd: cfg.flowGateMinExtSellUsd,
      flowGateMaxExtSellUsd: cfg.flowGateMaxExtSellUsd,
    });
    return;
  }
  if (gate.extSell) {
    appendFollowEvent(cfg, {
      kind: 'flow_entry_gate_pass',
      mint,
      leaderSignature: row.signature,
      extSellUsd: gate.extSell.usd,
      extSellLagSec: gate.extSell.lagSec,
      extSellSignature: gate.extSell.signature,
    });
  }

  scheduleFollowBuy(cfg, state, {
    mint,
    symbol,
    kind: 'entry',
    leaderSignature: row.signature,
    leaderPriceUsd: swap.priceUsd,
    leaderBuyUsd: swap.amountUsd,
    leaderBlockTimeSec: row.blockTime,
    poolAddress,
  });
}

/** Leader sells update ledger only — exits are price-ladder, not reactive copy. */
async function onLeaderSell(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  swap: SwapInsert,
  row: SignatureRow,
  preLeaderRaw: bigint,
): Promise<void> {
  const mint = swap.baseMint;
  const ts = leaderObservedMs(row) ?? Date.now();
  state.lastLeaderSellByMint[mint] = {
    ts,
    signature: row.signature,
    priceUsd: swap.priceUsd,
  };
  appendFollowEvent(cfg, {
    kind: 'leader_sell_observed',
    mint,
    leaderSignature: row.signature,
    leaderBlockTimeSec: row.blockTime ?? null,
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
  let poolHint = pending.poolAddress;
  if (!poolHint?.trim()) {
    const leaderTx = await fetchParsedTransaction(cfg.rpcUrl, pending.leaderSignature);
    if (leaderTx) {
      poolHint = extractPumpSwapPoolFromTx(leaderTx as TxJsonParsed) ?? undefined;
    }
  }

  const resolved = await resolveFollowPoolAddress(cfg, pending.mint, {
    poolHint,
  });
  const pool = resolved.pool;
  if (!pool) {
    appendFollowEvent(cfg, {
      kind: pending.kind === 'add' ? 'add_deferred' : 'buy_deferred',
      reason: 'no_pumpswap_pool',
      mint: pending.mint,
      leaderSignature: pending.leaderSignature,
      poolResolveSource: resolved.source,
    });
    return;
  }
  pending.poolAddress = pool;

  if (resolved.source === 'leader_usdc_skipped' && resolved.leaderUsdcPool) {
    appendFollowEvent(cfg, {
      kind: 'pool_resolve_wsol_alt',
      mint: pending.mint,
      leaderUsdcPool: resolved.leaderUsdcPool,
      wsolPool: pool,
      leaderSignature: pending.leaderSignature,
    });
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
    buyUsd: cfg.entryUsd,
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
  const leaderMs =
    pending.leaderBlockTimeSec && pending.leaderBlockTimeSec > 0
      ? pending.leaderBlockTimeSec * 1000
      : undefined;
  const lagMsAfterLeader = leaderMs != null ? nowMs - leaderMs : null;

  const leg = {
    ts: nowMs,
    usd: buy.usdAtMarket ?? cfg.entryUsd,
    fillPriceUsd: buy.fillPriceUsd,
    txSignature: buy.txSignature,
    kind: pending.kind === 'add' ? ('mirror_add' as const) : ('entry' as const),
  };

  const timingFields = {
    lagMsAfterLeader,
    leaderBlockTimeSec: pending.leaderBlockTimeSec ?? null,
    leaderSignature: pending.leaderSignature,
  };

  if (existing) {
    existing.legs.push(leg);
    if (buy.fillPriceUsd > existing.botPeakUsd) existing.botPeakUsd = buy.fillPriceUsd;
    if (cfg.executionMode === 'paper') {
      appendFollowEvent(cfg, {
        kind: 'add_ok',
        mode: cfg.executionMode,
        mint: pending.mint,
        symbol: pending.symbol,
        legUsd: leg.usd,
        fillPriceUsd: buy.fillPriceUsd,
        legs: existing.legs.length,
        ...timingFields,
      });
    } else {
      appendFollowEvent(cfg, {
        kind: 'mirror_add_timing',
        mode: 'live',
        mint: pending.mint,
        symbol: pending.symbol,
        legUsd: leg.usd,
        fillPriceUsd: buy.fillPriceUsd,
        legs: existing.legs.length,
        txSignature: buy.txSignature,
        ...timingFields,
      });
    }
  } else {
    delete state.lastLeaderSellByMint[pending.mint];
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
      waveB: cfg.exitPolicy === 'oscar_wave_b' ? initFollowWaveBState() : undefined,
    });
    if (cfg.executionMode === 'paper') {
      appendFollowEvent(cfg, {
        kind: 'buy_ok',
        mode: cfg.executionMode,
        mint: pending.mint,
        symbol: pending.symbol,
        intent: 'mirror_entry',
        legUsd: leg.usd,
        fillPriceUsd: buy.fillPriceUsd,
        leaderPriceUsd: pending.leaderPriceUsd,
        leaderBuyUsd: pending.leaderBuyUsd,
        ...timingFields,
      });
    } else {
      appendFollowEvent(cfg, {
        kind: 'mirror_buy_timing',
        mode: 'live',
        mint: pending.mint,
        symbol: pending.symbol,
        intent: 'mirror_entry',
        legUsd: leg.usd,
        fillPriceUsd: buy.fillPriceUsd,
        leaderPriceUsd: pending.leaderPriceUsd,
        leaderBuyUsd: pending.leaderBuyUsd,
        poolAddress: pool,
        poolResolveSource: resolved.source,
        txSignature: buy.txSignature,
        ...timingFields,
      });
    }
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

export async function ingestLeaderSignature(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  row: SignatureRow,
  source: 'poll' | 'ws',
): Promise<boolean> {
  if (state.seenSignatures[row.signature]) return false;
  if (row.err) {
    state.seenSignatures[row.signature] = Date.now();
    return false;
  }

  state.seenSignatures[row.signature] = Date.now();
  state.lastSignature = row.signature;

  const raw = await fetchParsedTransaction(cfg.rpcUrl, row.signature);
  if (!raw) return false;
  const tx = raw as TxJsonParsed;
  const swap = decodeSwapForWallet(tx, cfg.targetWallet, getSolUsd());
  if (!swap || swap.priceUsd <= 0) return false;

  const symbol = swap.baseMint.slice(0, 6);
  let preLeaderRaw = leaderPreBalanceRaw(state, swap.baseMint);
  if (swap.side === 'sell' && preLeaderRaw === 0n) {
    const post = await fetchWalletMintBalanceRaw(cfg.rpcUrl, cfg.targetWallet, swap.baseMint);
    preLeaderRaw = bootstrapLeaderPreSellBalance(post, swap.baseAmountRaw);
  }

  if (swap.side === 'buy') {
    await onLeaderBuy(cfg, state, swap, symbol, row, preLeaderRaw, tx);
  } else {
    await onLeaderSell(cfg, state, swap, row, preLeaderRaw);
  }
  applyLeaderSwapToLedger(state, swap.baseMint, swap.side, swap.baseAmountRaw);

  appendFollowEvent(cfg, {
    kind: source === 'ws' ? 'leader_ws_observed' : 'leader_poll_observed',
    mint: swap.baseMint,
    side: swap.side,
    leaderSignature: row.signature,
    leaderBlockTimeSec: row.blockTime ?? null,
  });
  return true;
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
    const ok = await ingestLeaderSignature(cfg, state, row, 'poll');
    if (ok) newSwaps++;
    await sleep(120);
  }

  if (newRows.length) writeFollowState(cfg, state);
  return { newSwaps, rpcFailed: false };
}

export async function handleLeaderWsSignature(
  cfg: PumpswapComboFollowConfig,
  args: { signature: string; err?: unknown | null },
): Promise<void> {
  const state = readFollowState(cfg);
  if (state.halted) return;
  const row: SignatureRow = { signature: args.signature, err: args.err ?? undefined };
  const ok = await ingestLeaderSignature(cfg, state, row, 'ws');
  writeFollowState(cfg, state);
  if (ok) await processPendingFollowBuys(cfg, state);
}
