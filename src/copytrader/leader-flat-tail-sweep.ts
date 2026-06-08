import type { CopyTraderConfig } from './config.js';
import { appendCopyEvent } from './executor.js';
import { leaderHasActiveJupiterSellOrders } from './jupiter-trigger-orders.js';
import { getLeaderLedger, leaderPreBalanceRaw } from './leader-ledger.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { fetchExecutionWalletBalanceRaw } from './position-reconcile.js';
import { fetchWalletMintBalanceRaw } from './rpc.js';
import type { CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sync ledger up when on-chain leader balance exceeds our estimate (missed buys). */
export function reconcileLeaderLedgerFromChain(
  state: CopyTraderState,
  mint: string,
  onChainRaw: bigint,
): void {
  if (onChainRaw <= 0n) return;
  const ledgerBal = leaderPreBalanceRaw(state, mint);
  if (onChainRaw > ledgerBal) {
    getLeaderLedger(state, mint).tokenRaw = onChainRaw.toString();
  }
}

async function fetchLeaderOnChainBalance(cfg: CopyTraderConfig, mint: string): Promise<bigint> {
  return fetchWalletMintBalanceRaw(cfg.rpcUrl, cfg.targetWallet, mint);
}

/**
 * Leader flat only when on-chain wallet holds zero (confirmed twice).
 * Ledger zero alone is not enough — partial sells can drain a stale ledger while leader still holds.
 */
export async function isLeaderFlatForMint(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  mint: string,
  symbol?: string,
): Promise<boolean> {
  const first = await fetchLeaderOnChainBalance(cfg, mint);
  if (first > 0n) {
    reconcileLeaderLedgerFromChain(state, mint, first);
    return false;
  }
  await sleep(cfg.leaderFlatConfirmDelayMs);
  const second = await fetchLeaderOnChainBalance(cfg, mint);
  if (second > 0n) {
    reconcileLeaderLedgerFromChain(state, mint, second);
    return false;
  }

  const jup = await leaderHasActiveJupiterSellOrders(cfg.targetWallet, mint);
  if (jup.active) {
    appendCopyEvent(cfg, {
      kind: 'leader_flat_suppressed',
      reason: 'jupiter_trigger_order_active',
      mint,
      symbol: symbol ?? null,
      jupiterOrderCount: jup.orderCount,
      jupiterRemainingRaw: jup.totalRemainingRaw,
      jupiterApiSource: jup.source,
      leaderWalletBalanceRaw: '0',
    });
    return false;
  }

  getLeaderLedger(state, mint).tokenRaw = '0';
  return true;
}

export function hasPendingSellForMint(state: CopyTraderState, mint: string): boolean {
  return state.pendingSells.some((p) => p.mint === mint);
}

/** Leader wallet empty but we still hold tokens — schedule 100% wallet exit. */
export async function scheduleLeaderFlatTailSweeps(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
): Promise<number> {
  const now = Date.now();
  let scheduled = 0;

  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    if (!(await isLeaderFlatForMint(cfg, state, mint, pos.symbol))) continue;
    if (hasPendingSellForMint(state, mint)) continue;

    const walletBal = await fetchExecutionWalletBalanceRaw(cfg, mint);
    if (walletBal === 0n) continue;

    const pending: PendingSell = {
      id: newId('ps'),
      mint,
      symbol: pos.symbol,
      leaderSignature: 'leader_flat_tail_sweep',
      leaderSellTs: now,
      dueTs: now,
      fraction: 1,
      leaderSellFraction: 1,
      retryUntilTs: computeRetryUntilTs(now, cfg.sellRetryWindowMs),
    };
    state.pendingSells.push(pending);
    scheduled += 1;
    appendCopyEvent(cfg, {
      kind: 'leader_flat_tail_sweep',
      mint,
      symbol: pos.symbol,
      walletTokenRaw: walletBal.toString(),
      sellDueTs: pending.dueTs,
      retryUntilTs: pending.retryUntilTs,
      leaderLedgerRaw: leaderPreBalanceRaw(state, mint).toString(),
    });
  }

  return scheduled;
}
