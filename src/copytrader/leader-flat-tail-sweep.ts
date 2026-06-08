import type { CopyTraderConfig } from './config.js';
import { appendCopyEvent } from './executor.js';
import { leaderPreBalanceRaw } from './leader-ledger.js';
import { computeRetryUntilTs } from './pending-buy-retry.js';
import { fetchExecutionWalletBalanceRaw } from './position-reconcile.js';
import type { CopyTraderState, PendingSell } from './state.js';
import { newId } from './state.js';

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
    if (leaderPreBalanceRaw(state, mint) > 0n) continue;
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
