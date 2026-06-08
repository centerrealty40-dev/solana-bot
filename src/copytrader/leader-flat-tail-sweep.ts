import type { CopyTraderConfig } from './config.js';
import { appendCopyEvent } from './executor.js';
import { getLeaderLedger, leaderPreBalanceRaw } from './leader-ledger.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { fetchExecutionWalletBalanceRaw } from './position-reconcile.js';
import { fetchWalletMintBalanceRaw } from './rpc.js';
import type { CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';

/** Leader flat when ledger says zero or on-chain wallet holds no tokens (missed poll txs). */
export async function isLeaderFlatForMint(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  mint: string,
): Promise<boolean> {
  if (leaderPreBalanceRaw(state, mint) === 0n) return true;
  const onChain = await fetchWalletMintBalanceRaw(cfg.rpcUrl, cfg.targetWallet, mint);
  if (onChain === 0n) {
    getLeaderLedger(state, mint).tokenRaw = '0';
    return true;
  }
  return false;
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
    if (!(await isLeaderFlatForMint(cfg, state, mint))) continue;
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
    });
  }

  return scheduled;
}
