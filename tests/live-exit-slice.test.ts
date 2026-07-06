import { describe, expect, it } from 'vitest';
import {
  planExitSellSlices,
  runSlicedTokenToSolPipeline,
} from '../src/live/exit-slice.js';
import type { LiveOscarConfig } from '../src/live/config.js';
import type { LiveTokenToSolPipelineResult } from '../src/live/phase4-types.js';
import {
  planExitSliceUsdNotional,
  shouldBypassExitSlicing,
} from '../src/live/wallet-balance-exit-reconcile.js';

describe('planExitSellSlices', () => {
  it('returns single slice when notional <= max', () => {
    expect(
      planExitSellSlices({ totalUsdNotional: 250, maxUsdPerSlice: 250, intentKind: 'sell_partial' }),
    ).toEqual([{ usdNotional: 250, intentKind: 'sell_partial' }]);
    expect(
      planExitSellSlices({ totalUsdNotional: 100, maxUsdPerSlice: 250, intentKind: 'sell_full' }),
    ).toEqual([{ usdNotional: 100, intentKind: 'sell_full' }]);
  });

  it('splits partial sells into max-USD chunks', () => {
    expect(
      planExitSellSlices({ totalUsdNotional: 600, maxUsdPerSlice: 250, intentKind: 'sell_partial' }),
    ).toEqual([
      { usdNotional: 250, intentKind: 'sell_partial' },
      { usdNotional: 250, intentKind: 'sell_partial' },
      { usdNotional: 100, intentKind: 'sell_partial' },
    ]);
  });

  it('ends full exit with sell_full on remainder', () => {
    expect(
      planExitSellSlices({ totalUsdNotional: 600, maxUsdPerSlice: 250, intentKind: 'sell_full' }),
    ).toEqual([
      { usdNotional: 250, intentKind: 'sell_partial' },
      { usdNotional: 250, intentKind: 'sell_partial' },
      { usdNotional: 100, intentKind: 'sell_full' },
    ]);
  });

  it('uses sell_full on last chunk when remainder is zero after full max slices', () => {
    expect(
      planExitSellSlices({ totalUsdNotional: 500, maxUsdPerSlice: 250, intentKind: 'sell_full' }),
    ).toEqual([
      { usdNotional: 250, intentKind: 'sell_partial' },
      { usdNotional: 250, intentKind: 'sell_full' },
    ]);
  });
});

describe('planExitSliceUsdNotional / shouldBypassExitSlicing', () => {
  it('uses min(journal, chain) for slice planning', () => {
    expect(planExitSliceUsdNotional({ journalUsd: 811, chainOscarUsd: 95 })).toBe(95);
    expect(planExitSliceUsdNotional({ journalUsd: 811, chainOscarUsd: 0 })).toBe(811);
  });

  it('bypasses slicing below max, tail, or bypass thresholds', () => {
    const cfg = {
      liveExitSliceMaxUsd: 400,
      liveTailFlushThresholdUsd: 100,
      liveExitSliceBypassBelowUsd: 100,
    } as LiveOscarConfig;
    expect(shouldBypassExitSlicing({ effectiveUsd: 400, liveCfg: cfg })).toBe(true);
    expect(shouldBypassExitSlicing({ effectiveUsd: 100, liveCfg: cfg })).toBe(true);
    expect(shouldBypassExitSlicing({ effectiveUsd: 95, liveCfg: cfg })).toBe(true);
    expect(shouldBypassExitSlicing({ effectiveUsd: 500, liveCfg: cfg })).toBe(false);
  });
});

describe('runSlicedTokenToSolPipeline', () => {
  const baseCfg = {
    liveExitSliceMaxUsd: 250,
    liveExitSliceDelayMs: 0,
    liveTailFlushThresholdUsd: 100,
    liveExitSliceBypassBelowUsd: 100,
  } as LiveOscarConfig;

  const args = {
    mint: 'Mint1111111111111111111111111111111111',
    symbol: 'TEST',
    usdNotional: 600,
    priceUsdPerToken: 1,
    decimals: 6,
    intentKind: 'sell_partial' as const,
  };

  it('passes through when slicing disabled (maxUsd=0)', async () => {
    let calls = 0;
    const runOne = async (): Promise<LiveTokenToSolPipelineResult> => {
      calls += 1;
      return { ok: true, wsolOutLamports: 1_000_000n };
    };
    const r = await runSlicedTokenToSolPipeline(
      { ...baseCfg, liveExitSliceMaxUsd: 0 },
      args,
      runOne,
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('runs dynamic slices and aggregates lamports', async () => {
    const notionals: number[] = [];
    const intents: Array<'sell_partial' | 'sell_full'> = [];
    let chainUsd = 600;
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number; intentKind: 'sell_partial' | 'sell_full' },
    ): Promise<LiveTokenToSolPipelineResult> => {
      notionals.push(a.usdNotional);
      intents.push(a.intentKind);
      chainUsd = Math.max(0, chainUsd - a.usdNotional);
      return { ok: true, wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)) };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne, {
      getChainOscarUsd: async () => chainUsd,
    });
    expect(r.ok).toBe(true);
    expect(notionals).toEqual([250, 250, 100]);
    expect(intents).toEqual(['sell_partial', 'sell_partial', 'sell_full']);
    expect(r.wsolOutLamports).toBe(600_000_000n);
  });

  it('uses single sell_full when chain remainder is below bypass threshold', async () => {
    const notionals: number[] = [];
    const intents: Array<'sell_partial' | 'sell_full'> = [];
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number; intentKind: 'sell_partial' | 'sell_full' },
    ): Promise<LiveTokenToSolPipelineResult> => {
      notionals.push(a.usdNotional);
      intents.push(a.intentKind);
      return { ok: true, wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)) };
    };
    const r = await runSlicedTokenToSolPipeline(
      baseCfg,
      { ...args, usdNotional: 811, intentKind: 'sell_full' },
      runOne,
      { getChainOscarUsd: async () => 95 },
    );
    expect(r.ok).toBe(true);
    expect(notionals).toEqual([95]);
    expect(intents).toEqual(['sell_full']);
  });

  it('stops and returns failure when a slice fails with no prior success', async () => {
    let calls = 0;
    const runOne = async (): Promise<LiveTokenToSolPipelineResult> => {
      calls += 1;
      if (calls === 1) return { ok: false };
      return { ok: true, wsolOutLamports: 100n };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne, {
      getChainOscarUsd: async () => 600,
    });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('returns partial proceeds when a later slice fails after success', async () => {
    let calls = 0;
    let chainUsd = 600;
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number },
    ): Promise<LiveTokenToSolPipelineResult> => {
      calls += 1;
      if (calls === 2) return { ok: false, preflightSkipReason: 'sim_err' };
      chainUsd = Math.max(0, chainUsd - a.usdNotional);
      return { ok: true, wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)) };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne, {
      getChainOscarUsd: async () => chainUsd,
    });
    expect(r.ok).toBe(false);
    expect(calls).toBe(2);
    expect(r.wsolOutLamports).toBe(250_000_000n);
    expect(r.preflightSkipReason).toBe('sim_err');
  });

  it('treats wallet zero after partial slices as success with proceeds', async () => {
    let calls = 0;
    let chainUsd = 600;
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number },
    ): Promise<LiveTokenToSolPipelineResult> => {
      calls += 1;
      chainUsd = Math.max(0, chainUsd - a.usdNotional);
      return {
        ok: true,
        wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)),
        sellAmountSource: calls === 2 ? 'usd_capped_by_chain' : 'usd_math',
        walletDrained: calls === 2,
      };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne, {
      getChainOscarUsd: async () => chainUsd,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(r.wsolOutLamports).toBe(500_000_000n);
    expect(r.sellAmountSource).toBe('usd_capped_by_chain');
    expect(r.walletDrained).toBe(true);
  });

  it('propagates sellAmountSource and walletDrained on full slice success', async () => {
    let chainUsd = 600;
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number; intentKind: 'sell_partial' | 'sell_full' },
    ): Promise<LiveTokenToSolPipelineResult> => {
      chainUsd = Math.max(0, chainUsd - a.usdNotional);
      return {
        ok: true,
        wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)),
        sellAmountSource: a.intentKind === 'sell_full' ? 'chain_full_balance' : 'usd_math',
        walletDrained: a.intentKind === 'sell_full',
      };
    };
    const fullArgs = { ...args, intentKind: 'sell_full' as const };
    const r = await runSlicedTokenToSolPipeline(baseCfg, fullArgs, runOne, {
      getChainOscarUsd: async () => chainUsd,
    });
    expect(r.ok).toBe(true);
    expect(r.sellAmountSource).toBe('chain_full_balance');
    expect(r.walletDrained).toBe(true);
  });

  it('invokes onSliceSuccess after each partial slice', async () => {
    const hookCalls: number[] = [];
    let chainUsd = 600;
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number },
    ): Promise<LiveTokenToSolPipelineResult> => {
      chainUsd = Math.max(0, chainUsd - a.usdNotional);
      return { ok: true, wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)) };
    };
    await runSlicedTokenToSolPipeline(baseCfg, args, runOne, {
      getChainOscarUsd: async () => chainUsd,
      onSliceSuccess: async (info) => {
        hookCalls.push(info.sliceIndex);
      },
    });
    expect(hookCalls).toEqual([0, 1]);
  });
});
