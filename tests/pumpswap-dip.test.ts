import { describe, expect, it } from 'vitest';
import { isDumpInBand, RollingHighTracker } from '../src/pumpswap-dip/rolling.js';

describe('pumpswap-dip rolling', () => {
  it('detects dump in configured band', () => {
    const t = new RollingHighTracker(900_000);
    const now = Date.now();
    t.push('mint1', now - 60_000, 1.0);
    t.push('mint1', now, 0.85);
    const dump = t.dumpPct('mint1', 0.85);
    expect(dump).not.toBeNull();
    expect(isDumpInBand(dump!, 10, 35)).toBe(true);
    expect(isDumpInBand(dump!, 20, 35)).toBe(false);
  });
});

describe('pumpswap-dip isolation', () => {
  it('rejects journal path overlapping live-oscar', async () => {
    const { assertPumpswapDipIsolation } = await import('../src/pumpswap-dip/isolation.js');
    expect(() =>
      assertPumpswapDipIsolation({
        strategyId: 'pumpswap-dip',
        executionMode: 'dry_run',
        journalPath: '/tmp/pt1-oscar-live.jsonl',
        statePath: '/tmp/pumpswap-dip/state.json',
        rpcUrl: 'https://example.com',
        pollIntervalMs: 3000,
        heartbeatIntervalMs: 30_000,
        watchlistMax: 40,
        minLiquidityUsd: 10_000,
        minMarketCapUsd: 20_000,
        maxMarketCapUsd: 5_000_000,
        minVolume5mUsd: 500,
        rollingHighWindowMs: 900_000,
        dumpMinPct: 10,
        dumpMaxPct: 35,
        takeProfitPct: 18,
        stopLossPct: 25,
        positionUsd: 400,
        maxOpenPositions: 5,
        maxBuysPerMintPerHour: 2,
        slippageBps: 600,
      }),
    ).toThrow(/overlaps/);
  });
});
