import { fetchWalletMintBalanceRawOrNull } from '../copytrader/rpc.js';
import type { MildDipConfig } from './config.js';

export async function readLeaderBalance(
  cfg: MildDipConfig,
  leader: string | null | undefined,
  mint: string,
): Promise<bigint | null> {
  if (!leader || !cfg.rpcUrl) return null;
  return fetchWalletMintBalanceRawOrNull(cfg.rpcUrl, leader, mint);
}

export async function leaderStillHolds(
  cfg: MildDipConfig,
  leader: string | null | undefined,
  mint: string,
): Promise<boolean> {
  const raw = await readLeaderBalance(cfg, leader, mint);
  return raw != null && raw > 0n;
}

export function leaderFlatReconcileDecision(args: {
  balanceRaw: bigint | null;
  confirmations: number;
  requiredConfirmations: number;
  openedAtMs: number;
  nowMs: number;
  minHoldMs: number;
}): 'hold' | 'confirm' | 'exit' {
  if (args.balanceRaw == null || args.nowMs - args.openedAtMs < args.minHoldMs) return 'hold';
  if (args.balanceRaw > 0n) return 'hold';
  return args.confirmations >= args.requiredConfirmations ? 'exit' : 'confirm';
}
