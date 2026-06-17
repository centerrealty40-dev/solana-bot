import { describe, expect, it } from 'vitest';
import {
  USDC_MINT,
  WSOL_MINT,
  buildShadowPriceEvent,
  computeStreamVsPgLagMs,
  extractStreamPoolPriceUsd,
  isQuoteMint,
  quoteAssetUsd,
  streamVsPgPriceDiffPct,
  uiAmountOf,
  type ShadowTokenBalance,
} from '../src/papertrader/stream/shadow-price.js';

const TOKEN = 'TokenMint1111111111111111111111111111111111';
const POOL = 'PoolAuthority1111111111111111111111111111111';
const USER = 'UserWallet11111111111111111111111111111111';

function bal(
  mint: string,
  owner: string,
  uiAmount: number | null,
  amount?: string,
  decimals?: number,
): ShadowTokenBalance {
  return { mint, owner, uiTokenAmount: { uiAmount, amount: amount ?? null, decimals: decimals ?? null } };
}

describe('quoteAssetUsd / isQuoteMint', () => {
  it('prices WSOL via solUsd and stablecoins at $1', () => {
    expect(quoteAssetUsd(WSOL_MINT, 150)).toBe(150);
    expect(quoteAssetUsd(USDC_MINT, 150)).toBe(1);
    expect(quoteAssetUsd(TOKEN, 150)).toBeNull();
    expect(quoteAssetUsd(WSOL_MINT, 0)).toBeNull();
    expect(quoteAssetUsd(null, 150)).toBeNull();
  });
  it('classifies quote mints', () => {
    expect(isQuoteMint(WSOL_MINT)).toBe(true);
    expect(isQuoteMint(USDC_MINT)).toBe(true);
    expect(isQuoteMint(TOKEN)).toBe(false);
  });
});

describe('uiAmountOf', () => {
  it('prefers uiAmount, falls back to amount/10^decimals', () => {
    expect(uiAmountOf(bal(TOKEN, POOL, 12.5))).toBe(12.5);
    expect(uiAmountOf(bal(TOKEN, POOL, null, '2500000', 6))).toBe(2.5);
    expect(uiAmountOf(bal(TOKEN, POOL, null))).toBe(0);
    expect(uiAmountOf(null)).toBe(0);
  });
});

describe('extractStreamPoolPriceUsd', () => {
  it('computes USD price from WSOL pool vault reserves owned by the pool', () => {
    const solUsd = 200;
    // pool: 1000 TOKEN base vault + 10 WSOL quote vault → price = 10*200/1000 = 2.0
    const balances: ShadowTokenBalance[] = [
      bal(TOKEN, POOL, 1000),
      bal(WSOL_MINT, POOL, 10),
      // a user's own WSOL ATA (different owner, larger) must not be picked as the pool quote vault
      bal(WSOL_MINT, USER, 9999),
    ];
    const r = extractStreamPoolPriceUsd(balances, TOKEN, solUsd);
    expect(r).not.toBeNull();
    expect(r!.priceUsd).toBeCloseTo(2.0, 9);
    expect(r!.quoteMint).toBe(WSOL_MINT);
    expect(r!.baseUiAmount).toBe(1000);
    expect(r!.quoteUiAmount).toBe(10);
  });

  it('computes USD price from a USDC pool ($1 quote)', () => {
    const balances: ShadowTokenBalance[] = [
      bal(TOKEN, POOL, 500),
      bal(USDC_MINT, POOL, 1500),
    ];
    const r = extractStreamPoolPriceUsd(balances, TOKEN, 123);
    expect(r!.priceUsd).toBeCloseTo(3.0, 9);
    expect(r!.quoteMint).toBe(USDC_MINT);
  });

  it('falls back to largest quote balance when no same-owner quote exists', () => {
    const balances: ShadowTokenBalance[] = [
      bal(TOKEN, POOL, 1000),
      bal(WSOL_MINT, USER, 10), // different owner; only quote candidate
    ];
    const r = extractStreamPoolPriceUsd(balances, TOKEN, 100);
    expect(r!.priceUsd).toBeCloseTo(1.0, 9);
  });

  it('returns null when base mint is absent or there is no quote vault', () => {
    expect(extractStreamPoolPriceUsd([bal(WSOL_MINT, POOL, 10)], TOKEN, 100)).toBeNull();
    expect(extractStreamPoolPriceUsd([bal(TOKEN, POOL, 1000)], TOKEN, 100)).toBeNull();
    expect(extractStreamPoolPriceUsd([], TOKEN, 100)).toBeNull();
    expect(extractStreamPoolPriceUsd(null, TOKEN, 100)).toBeNull();
  });

  it('returns null when WSOL quote but solUsd is unknown', () => {
    const balances = [bal(TOKEN, POOL, 1000), bal(WSOL_MINT, POOL, 10)];
    expect(extractStreamPoolPriceUsd(balances, TOKEN, 0)).toBeNull();
  });
});

describe('computeStreamVsPgLagMs', () => {
  it('positive when PG snapshot is older than the stream tick', () => {
    expect(computeStreamVsPgLagMs(10_000, 4_000)).toBe(6_000);
  });
  it('negative when PG is somehow newer (clock skew)', () => {
    expect(computeStreamVsPgLagMs(4_000, 10_000)).toBe(-6_000);
  });
  it('null when a timestamp is missing', () => {
    expect(computeStreamVsPgLagMs(10_000, null)).toBeNull();
    expect(computeStreamVsPgLagMs(null, 10_000)).toBeNull();
  });
});

describe('streamVsPgPriceDiffPct', () => {
  it('signed percent diff of stream vs PG', () => {
    expect(streamVsPgPriceDiffPct(110, 100)).toBeCloseTo(10, 9);
    expect(streamVsPgPriceDiffPct(90, 100)).toBeCloseTo(-10, 9);
  });
  it('null when PG price is non-positive or missing', () => {
    expect(streamVsPgPriceDiffPct(110, 0)).toBeNull();
    expect(streamVsPgPriceDiffPct(110, null)).toBeNull();
    expect(streamVsPgPriceDiffPct(null, 100)).toBeNull();
  });
});

describe('buildShadowPriceEvent', () => {
  it('builds the live_shyft_shadow_price record with derived lag/age/diff', () => {
    const ev = buildShadowPriceEvent({
      mint: TOKEN,
      lane: 'A',
      surface: 'entry',
      streamPriceUsd: 2.2,
      pgPriceUsd: 2.0,
      streamTsMs: 100_000,
      pgSnapshotTsMs: 70_000,
      streamSlot: 42,
      nowMs: 100_500,
    });
    expect(ev.kind).toBe('live_shyft_shadow_price');
    expect(ev.mint).toBe(TOKEN);
    expect(ev.lane).toBe('A');
    expect(ev.surface).toBe('entry');
    expect(ev.streamVsPgLagMs).toBe(30_000); // 100k − 70k
    expect(ev.pgPriceAgeMs).toBe(30_500); // now − pgSnapshotTs
    expect(ev.streamVsPgPriceDiffPct).toBeCloseTo(10, 6);
    expect(ev.streamSlot).toBe(42);
  });

  it('tolerates missing PG price / snapshot ts', () => {
    const ev = buildShadowPriceEvent({
      mint: TOKEN,
      lane: 'mtm',
      streamPriceUsd: 1.0,
      pgPriceUsd: null,
      streamTsMs: 5_000,
      pgSnapshotTsMs: null,
      nowMs: 6_000,
    });
    expect(ev.streamVsPgLagMs).toBeNull();
    expect(ev.pgPriceAgeMs).toBeNull();
    expect(ev.streamVsPgPriceDiffPct).toBeNull();
    expect(ev.streamSlot).toBeUndefined();
  });
});
