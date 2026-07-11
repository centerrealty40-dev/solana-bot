import { describe, expect, it } from 'vitest';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  __resetPendingLegPgRefreshForTests,
  buildPendingLegSnapshotUpsertRow,
  pendingLegPgRefreshBucketTs,
  pendingLegPgRefreshDue,
  resolvePendingLegSnapshotSource,
  snapshotTableForDexSource,
  maybeRefreshPendingLegPgForOpenTrade,
} from '../src/papertrader/pricing/pending-leg-pg-refresh.js';
import type { DexScreenerPairDetails } from '../src/papertrader/pricing/dexscreener-quote-cache.js';

const BASE_DETAILS: DexScreenerPairDetails = {
  priceUsd: 0.21,
  marketCapUsd: 500_000,
  liquidityUsd: 80_000,
  volume5mUsd: 12_000,
  volume1hUsd: 90_000,
  pairAddress: 'PairAddr111',
  baseMint: 'Mint111111111111111111111111111111111111111',
  quoteMint: 'So11111111111111111111111111111111111111112',
  dexId: 'meteora',
  buys5m: 10,
  sells5m: 8,
  fetchedAtMs: 1_700_000_000_000,
};

function pendingLegOpenTrade(): OpenTrade {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    source: 'meteora',
    remainingFraction: 0.5,
    totalInvestedUsd: 250,
    avgEntry: 0.213,
    avgEntryMarket: 0.213,
    partialSells: [],
    legs: [],
    liveStagedEntry: {
      entrySplitV2: true,
      entrySplitDelayMs: 10_000,
      entrySplitLegUsd: 250,
      entrySplitLeg2Usd: 250,
      entrySplitLeg2Done: false,
      signalTs: 1_700_000_000_000 - 60_000,
    },
  } as OpenTrade;
}

describe('pendingLegPgRefreshBucketTs', () => {
  it('floors to 30s UTC buckets', () => {
    const ts = pendingLegPgRefreshBucketTs(1_700_000_045_000, 30);
    expect(ts.getTime()).toBe(1_700_000_040_000);
  });

  it('clamps bucket sec to [15, 120]', () => {
    expect(pendingLegPgRefreshBucketTs(90_000, 5).getTime()).toBe(90_000);
    expect(pendingLegPgRefreshBucketTs(300_000, 200).getTime() % 120_000).toBe(0);
  });
});

describe('pendingLegPgRefreshDue', () => {
  it('respects per-mint cooldown', () => {
    const map = new Map<string, number>([['mintA', 1_000_000]]);
    expect(pendingLegPgRefreshDue('mintA', 1_046_000, 45_000, map)).toBe(true);
    expect(pendingLegPgRefreshDue('mintA', 1_010_000, 45_000, map)).toBe(false);
    expect(pendingLegPgRefreshDue('mintB', 1_010_000, 45_000, map)).toBe(true);
  });
});

describe('resolvePendingLegSnapshotSource', () => {
  it('prefers trade source when set', () => {
    expect(resolvePendingLegSnapshotSource('raydium', 'meteora')).toBe('meteora');
  });

  it('infers from dexId', () => {
    expect(resolvePendingLegSnapshotSource('meteora-dlmm', null)).toBe('meteora');
    expect(resolvePendingLegSnapshotSource('pumpswap', null)).toBe('pumpswap');
  });
});

describe('buildPendingLegSnapshotUpsertRow', () => {
  it('builds upsert row with bucket ts', () => {
    const bucketTs = pendingLegPgRefreshBucketTs(1_700_000_045_000, 30);
    const row = buildPendingLegSnapshotUpsertRow({
      details: BASE_DETAILS,
      bucketTs,
      source: 'meteora',
    });
    expect(row?.pairAddress).toBe('PairAddr111');
    expect(row?.ts).toBe(bucketTs);
    expect(row?.priceUsd).toBe(0.21);
    expect(snapshotTableForDexSource('meteora')).toBe('meteora_pair_snapshots');
  });

  it('returns null without price', () => {
    const row = buildPendingLegSnapshotUpsertRow({
      details: { ...BASE_DETAILS, priceUsd: null },
      bucketTs: new Date(),
      source: 'meteora',
    });
    expect(row).toBeNull();
  });
});

describe('maybeRefreshPendingLegPgForOpenTrade', () => {
  it('skips when disabled', async () => {
    __resetPendingLegPgRefreshForTests();
    const r = await maybeRefreshPendingLegPgForOpenTrade({
      cfg: {
        livePendingLegPgRefreshEnabled: false,
        livePendingLegPgRefreshCooldownMs: 45_000,
        livePendingLegPgRefreshBucketSec: 30,
      },
      ot: pendingLegOpenTrade(),
      mint: pendingLegOpenTrade().mint!,
    });
    expect(r).toEqual({ refreshed: false, reason: 'disabled' });
  });

  it('skips when no pending entry-split leg', async () => {
    __resetPendingLegPgRefreshForTests();
    const ot = pendingLegOpenTrade();
    ot.liveStagedEntry!.entrySplitLeg2Done = true;
    const r = await maybeRefreshPendingLegPgForOpenTrade({
      cfg: {
        livePendingLegPgRefreshEnabled: true,
        livePendingLegPgRefreshCooldownMs: 45_000,
        livePendingLegPgRefreshBucketSec: 30,
      },
      ot,
      mint: ot.mint!,
    });
    expect(r).toEqual({ refreshed: false, reason: 'no_pending_leg' });
  });
});
