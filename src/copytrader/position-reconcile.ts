import { COPY_TRADER_RISKY_WALLET_PUBKEY } from './isolation.js';
import type { CopyTraderConfig } from './config.js';
import { cancelPendingBuysForMint } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import { appendCopyEvent } from './executor.js';
import { fetchWalletMintBalanceRaw } from './rpc.js';
import type { CopyTraderState } from './state.js';

export function executionWalletPubkey(cfg: CopyTraderConfig): string {
  return cfg.walletPubkeyExpected ?? COPY_TRADER_RISKY_WALLET_PUBKEY;
}

/** Drop state row when execution wallet holds no tokens (manual exit / drift). */
export async function reconcileGhostPositions(cfg: CopyTraderConfig, state: CopyTraderState): Promise<number> {
  const wallet = executionWalletPubkey(cfg);
  let cleared = 0;
  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    const bal = await fetchWalletMintBalanceRaw(cfg.rpcUrl, wallet, mint);
    if (bal !== 0n) continue;
    delete state.positions[mint];
    cancelPendingBuysForMint(state, mint, 'any');
    cancelPendingSellsForMint(state, mint);
    cleared += 1;
    appendCopyEvent(cfg, {
      kind: 'position_closed_wallet_empty',
      mint,
      symbol: pos.symbol,
      reason: 'wallet_balance_zero',
    });
  }
  return cleared;
}

export function closePositionForMint(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  mint: string,
  reason: string,
): boolean {
  const pos = state.positions[mint];
  if (!pos) return false;
  delete state.positions[mint];
  cancelPendingBuysForMint(state, mint, 'any');
  cancelPendingSellsForMint(state, mint);
  appendCopyEvent(cfg, {
    kind: 'position_closed_wallet_empty',
    mint,
    symbol: pos.symbol,
    reason,
  });
  return true;
}
