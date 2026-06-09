import { describe, expect, it, vi } from 'vitest';
import {
  hasPendingSellForMint,
  isLeaderFlatForMint,
  reconcileLeaderLedgerFromChain,
} from '../../src/copytrader/leader-flat-tail-sweep.js';
import { leaderPreBalanceRaw } from '../../src/copytrader/leader-ledger.js';
import * as executor from '../../src/copytrader/executor.js';
import * as jupOrders from '../../src/copytrader/jupiter-trigger-orders.js';
import * as rpc from '../../src/copytrader/rpc.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';

const cfg = {
  rpcUrl: 'http://rpc',
  targetWallet: 'LeaderWallet1111111111111111111111111111',
  leaderFlatConfirmDelayMs: 0,
  leaderFlatDustRaw: 10_000n,
} as CopyTraderConfig;

describe('leader flat tail sweep', () => {
  it('detects pending sell for mint', () => {
    const state = emptyCopyTraderState();
    state.pendingSells.push({
      id: 'ps_1',
      mint: 'mintA',
      symbol: 'A',
      leaderSignature: 'sig',
      leaderSellTs: 0,
      dueTs: 0,
      fraction: 1,
      retryUntilTs: 9999,
    });
    expect(hasPendingSellForMint(state, 'mintA')).toBe(true);
    expect(hasPendingSellForMint(state, 'mintB')).toBe(false);
  });

  it('ledger zero alone does not mean leader flat when on-chain still holds', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '0' };
    vi.spyOn(rpc, 'fetchWalletMintBalanceRaw').mockResolvedValue(12_000_000n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA')).resolves.toBe(false);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(12_000_000n);
    vi.restoreAllMocks();
  });

  it('reconciles ledger up from on-chain when ledger undercounts', () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '0' };
    reconcileLeaderLedgerFromChain(state, 'mintA', 9_000_000n, 10_000n);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(9_000_000n);
  });

  it('reconciles ledger to zero when on-chain is dust', () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '95000000000' };
    reconcileLeaderLedgerFromChain(state, 'mintA', 1n, 10_000n);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(0n);
  });

  it('leader flat when on-chain holds only dust', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '95000000000' };
    vi.spyOn(jupOrders, 'leaderHasActiveJupiterSellOrders').mockResolvedValue({
      active: false,
      orderCount: 0,
      totalRemainingRaw: '0',
      source: 'pro',
    });
    const spy = vi
      .spyOn(rpc, 'fetchWalletMintBalanceRaw')
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(1n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA')).resolves.toBe(true);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(0n);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('leader flat only after two on-chain zero reads', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '9000000' };
    vi.spyOn(jupOrders, 'leaderHasActiveJupiterSellOrders').mockResolvedValue({
      active: false,
      orderCount: 0,
      totalRemainingRaw: '0',
      source: 'pro',
    });
    const spy = vi
      .spyOn(rpc, 'fetchWalletMintBalanceRaw')
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA')).resolves.toBe(true);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(0n);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('not flat when wallet zero but Jupiter trigger sell order active', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '9000000' };
    vi.spyOn(jupOrders, 'leaderHasActiveJupiterSellOrders').mockResolvedValue({
      active: true,
      orderCount: 1,
      totalRemainingRaw: '1000000',
      source: 'pro',
    });
    vi.spyOn(executor, 'appendCopyEvent').mockImplementation(() => {});
    vi.spyOn(rpc, 'fetchWalletMintBalanceRaw').mockResolvedValue(0n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA', 'SYM')).resolves.toBe(false);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(9_000_000n);
    vi.restoreAllMocks();
  });

  it('leader not flat when second on-chain read shows tokens', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '0' };
    vi.spyOn(rpc, 'fetchWalletMintBalanceRaw')
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(5_000_000n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA')).resolves.toBe(false);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(5_000_000n);
    vi.restoreAllMocks();
  });
});
