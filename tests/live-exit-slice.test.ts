import { describe, expect, it } from 'vitest';
import { planExitSellSlices, runSlicedTokenToSolPipeline } from '../src/live/exit-slice.js';
import type { LiveOscarConfig } from '../src/live/config.js';
import type { LiveTokenToSolPipelineResult } from '../src/live/phase4-types.js';

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

describe('runSlicedTokenToSolPipeline', () => {
  const baseCfg = {
    liveExitSliceMaxUsd: 250,
    liveExitSliceDelayMs: 0,
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

  it('runs multiple slices and aggregates lamports', async () => {
    const notionals: number[] = [];
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number },
    ): Promise<LiveTokenToSolPipelineResult> => {
      notionals.push(a.usdNotional);
      return { ok: true, wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)) };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne);
    expect(r.ok).toBe(true);
    expect(notionals).toEqual([250, 250, 100]);
    expect(r.wsolOutLamports).toBe(600_000_000n);
  });

  it('stops and returns failure when a slice fails', async () => {
    let calls = 0;
    const runOne = async (): Promise<LiveTokenToSolPipelineResult> => {
      calls += 1;
      if (calls === 2) return { ok: false };
      return { ok: true, wsolOutLamports: 100n };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne);
    expect(r.ok).toBe(false);
    expect(calls).toBe(2);
    expect(r.wsolOutLamports).toBe(100n);
  });

  it('propagates preflightSkipReason and walletDrained after partial slice success', async () => {
    let calls = 0;
    const runOne = async (): Promise<LiveTokenToSolPipelineResult> => {
      calls += 1;
      if (calls === 3) {
        return {
          ok: false,
          preflightSkipReason: 'wallet_spl_balance_zero',
        };
      }
      return {
        ok: true,
        wsolOutLamports: 250_000_000n,
        sellAmountSource: calls === 2 ? 'usd_capped_by_chain' : 'usd_math',
        walletDrained: calls === 2,
      };
    };
    const r = await runSlicedTokenToSolPipeline(baseCfg, args, runOne);
    expect(r.ok).toBe(false);
    expect(calls).toBe(3);
    expect(r.wsolOutLamports).toBe(500_000_000n);
    expect(r.preflightSkipReason).toBe('wallet_spl_balance_zero');
    expect(r.sellAmountSource).toBe('usd_capped_by_chain');
    expect(r.walletDrained).toBe(true);
  });

  it('propagates sellAmountSource and walletDrained on full slice success', async () => {
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number; intentKind: 'sell_partial' | 'sell_full' },
    ): Promise<LiveTokenToSolPipelineResult> => ({
      ok: true,
      wsolOutLamports: BigInt(Math.round(a.usdNotional * 1e6)),
      sellAmountSource: a.intentKind === 'sell_full' ? 'chain_full_balance' : 'usd_math',
      walletDrained: a.intentKind === 'sell_full',
    });
    const fullArgs = { ...args, intentKind: 'sell_full' as const };
    const r = await runSlicedTokenToSolPipeline(baseCfg, fullArgs, runOne);
    expect(r.ok).toBe(true);
    expect(r.sellAmountSource).toBe('chain_full_balance');
    expect(r.walletDrained).toBe(true);
  });
});
