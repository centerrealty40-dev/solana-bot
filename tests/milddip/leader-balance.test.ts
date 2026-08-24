import { describe, expect, it, vi } from 'vitest';

const { fetchBalance } = vi.hoisted(() => ({ fetchBalance: vi.fn() }));
vi.mock('../../src/copytrader/rpc.js', () => ({
  fetchWalletMintBalanceRawOrNull: fetchBalance,
}));

import {
  leaderBalanceGuardReason,
  leaderFlatReconcileDecision,
  leaderStillHolds,
  readLeaderBalanceForGuard,
} from '../../src/milddip/leader-balance.js';

describe('leader balance guard', () => {
  it('uses the program-agnostic mint filter, including Token-2022 accounts', async () => {
    fetchBalance.mockResolvedValue(42n);
    const cfg = { rpcUrl: 'https://rpc.example' } as never;
    await expect(leaderStillHolds(cfg, 'leader', 'token-2022-mint')).resolves.toBe(true);
    expect(fetchBalance).toHaveBeenCalledWith('https://rpc.example', 'leader', 'token-2022-mint');
  });

  it('fails closed when the balance RPC fails', async () => {
    fetchBalance.mockResolvedValue(null);
    const cfg = { rpcUrl: 'https://rpc.example' } as never;
    await expect(leaderStillHolds(cfg, 'leader', 'mint')).resolves.toBe(false);
  });

  it('distinguishes a missing leader from an RPC failure', async () => {
    const cfg = { rpcUrl: 'https://rpc.example' } as never;
    fetchBalance.mockClear();
    await expect(readLeaderBalanceForGuard(cfg, null, 'mint')).resolves.toEqual({
      balanceRaw: null,
      reason: 'leader_missing',
    });
    expect(fetchBalance).not.toHaveBeenCalled();

    fetchBalance.mockResolvedValue(null);
    await expect(readLeaderBalanceForGuard(cfg, 'leader', 'mint')).resolves.toEqual({
      balanceRaw: null,
      reason: 'rpc_error',
    });
    expect(leaderBalanceGuardReason({ balanceRaw: null, reason: 'leader_missing' })).toBe(
      'leader_balance_leader_missing',
    );
    expect(leaderBalanceGuardReason({ balanceRaw: null, reason: 'rpc_error' })).toBe(
      'leader_balance_rpc_error',
    );
    expect(leaderBalanceGuardReason({ balanceRaw: 0n, reason: null })).toBe(
      'leader_balance_zero',
    );
    expect(leaderBalanceGuardReason({ balanceRaw: 1n, reason: null })).toBe(
      'leader_balance_nonzero',
    );
  });

  it('requires age and consecutive flat confirmations before exit', () => {
    expect(leaderFlatReconcileDecision({
      balanceRaw: 0n,
      confirmations: 1,
      requiredConfirmations: 2,
      openedAtMs: 100,
      nowMs: 10_000,
      minHoldMs: 30_000,
    })).toBe('hold');
    expect(leaderFlatReconcileDecision({
      balanceRaw: 0n,
      confirmations: 1,
      requiredConfirmations: 2,
      openedAtMs: 100,
      nowMs: 40_000,
      minHoldMs: 30_000,
    })).toBe('confirm');
    expect(leaderFlatReconcileDecision({
      balanceRaw: 0n,
      confirmations: 2,
      requiredConfirmations: 2,
      openedAtMs: 100,
      nowMs: 40_000,
      minHoldMs: 30_000,
    })).toBe('exit');
    expect(leaderFlatReconcileDecision({
      balanceRaw: 1n,
      confirmations: 2,
      requiredConfirmations: 2,
      openedAtMs: 100,
      nowMs: 40_000,
      minHoldMs: 30_000,
    })).toBe('hold');
  });
});
