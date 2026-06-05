import type { CopyTraderConfig } from './config.js';
import { leaderLedgerIsZero } from './exit-coalesce.js';
import { leaderPreBalanceRaw } from './leader-ledger.js';
import { fetchExecutionWalletBalanceRaw } from './position-reconcile.js';
import { hasFullExitPending, schedulePendingSell } from './pending-sell-schedule.js';
import type { CopyTraderState } from './state.js';

const SWEEP_SIG = 'leader_flat_sweep';

/** Leader ledger is zero but execution wallet still holds tokens — queue one full exit. */
export async function sweepLeaderZeroHoldings(cfg: CopyTraderConfig, state: CopyTraderState): Promise<number> {
  const mints = new Set<string>([
    ...Object.keys(state.positions),
    ...Object.keys(state.leaderLedger),
  ]);
  let scheduled = 0;

  for (const mint of mints) {
    if (!leaderLedgerIsZero(state.leaderLedger[mint]?.tokenRaw)) continue;
    if (hasFullExitPending(state, mint)) continue;

    const walletBal = await fetchExecutionWalletBalanceRaw(cfg, mint);
    if (walletBal === 0n) continue;

    const pos = state.positions[mint];
    const symbol = pos?.symbol ?? mint.slice(0, 6);
    schedulePendingSell({
      cfg,
      state,
      mint,
      symbol,
      leaderSignature: SWEEP_SIG,
      leaderSellTs: Date.now(),
      fraction: 1,
      leaderSellFraction: 1,
      sweepReason: 'leader_ledger_zero',
    });
    scheduled += 1;
  }

  return scheduled;
}

export function leaderFlatForMint(state: CopyTraderState, mint: string): boolean {
  return leaderLedgerIsZero(state.leaderLedger[mint]?.tokenRaw) || leaderPreBalanceRaw(state, mint) <= 0n;
}
