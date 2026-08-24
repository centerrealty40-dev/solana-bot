import { fetchWalletMintBalanceRawOrNull } from '../copytrader/rpc.js';
import type { MildDipConfig } from './config.js';

export type LeaderBalanceGuardRead = {
  balanceRaw: bigint | null;
  reason: 'leader_missing' | 'rpc_error' | null;
};

export async function readLeaderBalance(
  cfg: MildDipConfig,
  leader: string | null | undefined,
  mint: string,
): Promise<bigint | null> {
  if (!leader || !cfg.rpcUrl) return null;
  return fetchWalletMintBalanceRawOrNull(cfg.rpcUrl, leader, mint);
}

export async function readLeaderBalanceForGuard(
  cfg: MildDipConfig,
  leader: string | null | undefined,
  mint: string,
): Promise<LeaderBalanceGuardRead> {
  if (!leader) return { balanceRaw: null, reason: 'leader_missing' };
  if (!cfg.rpcUrl) return { balanceRaw: null, reason: 'rpc_error' };
  const balanceRaw = await fetchWalletMintBalanceRawOrNull(cfg.rpcUrl, leader, mint);
  return balanceRaw == null
    ? { balanceRaw: null, reason: 'rpc_error' }
    : { balanceRaw, reason: null };
}

export function leaderBalanceGuardReason(
  read: LeaderBalanceGuardRead,
): 'leader_balance_leader_missing' | 'leader_balance_rpc_error' | 'leader_balance_zero' | 'leader_balance_nonzero' {
  if (read.reason === 'leader_missing') return 'leader_balance_leader_missing';
  if (read.reason === 'rpc_error') return 'leader_balance_rpc_error';
  return read.balanceRaw != null && read.balanceRaw > 0n
    ? 'leader_balance_nonzero'
    : 'leader_balance_zero';
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
