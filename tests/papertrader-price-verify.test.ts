import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyEntryPrice, verifyExitPrice } from '../src/papertrader/pricing/price-verify.js';

const baseCfg = {
  priceVerifyEnabled: true,
  priceVerifyBlockOnFail: true,
  priceVerifyUseJupiterPrice: false,
  priceVerifyMaxSlipPct: 4.0,
  priceVerifyMaxSlipBps: 400,
  priceVerifyMaxPriceImpactPct: 8.0,
  priceVerifyTimeoutMs: 1500,
  priceVerifyExitEnabled: true,
  priceVerifyExitBlockOnFail: true,
} as never;

const mintFoo = 'FoooooofakeMint11111111111111111111111111111';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockJupiter(body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('verifyEntryPrice', () => {
  it('returns skipped when feature disabled', async () => {
    const v = await verifyEntryPrice({
      cfg: { ...baseCfg, priceVerifyEnabled: false } as never,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('skipped');
    expect(v.kind === 'skipped' && v.reason).toBe('feature-disabled');
  });

  it('returns ok when slip within threshold', async () => {
    mockJupiter({ outAmount: '1000000000000', priceImpactPct: '0.005', routePlan: [{}] });
    const v = await verifyEntryPrice({
      cfg: baseCfg,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') {
      expect(v.jupiterPriceUsd).toBeCloseTo(0.0001, 8);
      expect(v.slipPct).toBeCloseTo(0, 4);
      expect(v.routeHops).toBe(1);
    }
  });

  it('blocks when slip > threshold', async () => {
    mockJupiter({ outAmount: '1100000000000', priceImpactPct: '0.005', routePlan: [{}] });
    const v = await verifyEntryPrice({
      cfg: baseCfg,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('blocked');
    if (v.kind === 'blocked') expect(v.reason).toBe('slip-too-high');
  });

  it('blocks when priceImpact too high', async () => {
    mockJupiter({ outAmount: '1000000000000', priceImpactPct: '0.10', routePlan: [{}] });
    const v = await verifyEntryPrice({
      cfg: baseCfg,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('blocked');
    if (v.kind === 'blocked') expect(v.reason).toBe('impact-too-high');
  });

  it('blocks no-route on outAmount=0', async () => {
    mockJupiter({ outAmount: '0', priceImpactPct: '0', routePlan: [] });
    const v = await verifyEntryPrice({
      cfg: baseCfg,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('blocked');
    if (v.kind === 'blocked') expect(v.reason).toBe('no-route');
  });

  it('returns skipped on http 502', async () => {
    mockJupiter({}, 502);
    const v = await verifyEntryPrice({
      cfg: baseCfg,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('skipped');
    if (v.kind === 'skipped') expect(v.reason).toBe('http-error');
  });

  it('returns skipped when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const v = await verifyEntryPrice({
      cfg: baseCfg,
      mint: mintFoo,
      outMintDecimals: 6,
      sizeUsd: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('skipped');
    if (v.kind === 'skipped') expect(v.reason).toBe('fetch-fail');
  });
});

describe('verifyExitPrice (W7.4.2)', () => {
  it('returns skipped feature-disabled when exit verify off', async () => {
    const v = await verifyExitPrice({
      cfg: { ...baseCfg, priceVerifyExitEnabled: false } as never,
      mint: mintFoo,
      tokenDecimals: 6,
      usdNotional: 50,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('skipped');
    if (v.kind === 'skipped') expect(v.reason).toBe('feature-disabled');
  });

  it('returns ok when sell slip within threshold', async () => {
    mockJupiter({ outAmount: '625000000', priceImpactPct: '0.005', routePlan: [{}] });
    const v = await verifyExitPrice({
      cfg: baseCfg,
      mint: mintFoo,
      tokenDecimals: 6,
      usdNotional: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') {
      expect(v.jupiterPriceUsd).toBeCloseTo(0.0001, 8);
      expect(v.slipPct).toBeCloseTo(0, 4);
    }
  });

  it('blocks when sell slip > threshold', async () => {
    mockJupiter({ outAmount: '312500000', priceImpactPct: '0.005', routePlan: [{}] });
    const v = await verifyExitPrice({
      cfg: baseCfg,
      mint: mintFoo,
      tokenDecimals: 6,
      usdNotional: 100,
      solUsd: 160,
      snapshotPriceUsd: 0.0001,
    });
    expect(v.kind).toBe('blocked');
    if (v.kind === 'blocked') expect(v.reason).toBe('slip-too-high');
  });
});
