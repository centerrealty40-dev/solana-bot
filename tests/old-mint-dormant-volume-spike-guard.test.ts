import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateOldMintDormantVolSpikeGuard,
  type OldMintDormantVolSpikeFeatures,
} from '../src/papertrader/discovery/old-mint-dormant-volume-spike-guard.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

const DADDY_MINT = '4Cnk9EPnW5ixfLZatCPJjDB1PUtcRpVVgTQukm9epump';

function baseRow(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: DADDY_MINT,
    symbol: 'DADDY',
    ts: new Date(),
    launch_ts: null,
    age_min: 23980,
    price_usd: 0.02955819,
    liquidity_usd: 1_328_500,
    volume_5m: 3628,
    volume_1h: 130_113,
    buys_5m: 10,
    sells_5m: 8,
    market_cap_usd: 17_723_538,
    source: 'raydium',
    holder_count: 4000,
    token_age_min: 150 * 1440,
    pair_address: null,
    ...over,
  };
}

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    oldMintDormantVolSpikeGuardEnabled: true,
    oldMintDormantVolSpikeMinTokenAgeDays: 100,
    oldMintDormantVolSpikeMaxYoungTokenAgeDays: 7,
    oldMintDormantVolSpikeLookbackHours: 120,
    oldMintDormantVolSpikeDormantLookbackHours: 72,
    oldMintDormantVolSpikeRecentHours: 6,
    oldMintDormantVolSpikeDormantVol1hMaxUsd: 10_000,
    oldMintDormantVolSpikeDormantVol5mMaxUsd: 5_000,
    oldMintDormantVolSpikeMinDormantHourFraction: 0.75,
    oldMintDormantVolSpikeMinBaselineHours: 24,
    oldMintDormantVolSpikeMinSpikeVol1hUsd: 25_000,
    oldMintDormantVolSpikeVol1hRatioMin: 5,
    ...over,
  } as PaperTraderConfig;
}

/** PG context mocked from prod RCA (Jul 5 2026 entry): dormant median ~$7k, spike vol1h $130k+. */
function daddyCtx(over: Partial<OldMintDormantVolSpikeFeatures> = {}): OldMintDormantVolSpikeFeatures {
  return {
    lookbackHours: 120,
    dormantLookbackHours: 72,
    recentHours: 6,
    tokenAgeDays: null,
    baselineHoursWithData: 60,
    dormantHours: 52,
    dormantHourFraction: 0.87,
    baselineMedianVol1hUsd: 7032,
    baselineMedianVol5mUsd: 1308,
    baselineP90Vol1hUsd: 8500,
    recentMaxVol1hUsd: 130_113,
    recentMaxVol5mUsd: 743_253,
    currentVol1hUsd: null,
    currentVol5mUsd: null,
    effectiveRecentVol1hUsd: null,
    vol1hSpikeRatio: null,
    coverageOk: true,
    ...over,
  };
}

describe('evaluateOldMintDormantVolSpikeGuard', () => {
  it('passes when guard disabled', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg({ oldMintDormantVolSpikeGuardEnabled: false }),
      baseRow(),
      daddyCtx(),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes young pump mint (< maxYoungTokenAgeDays)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({ token_age_min: 3 * 1440 }),
      daddyCtx(),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes when token age below min threshold', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({ token_age_min: 30 * 1440 }),
      daddyCtx(),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes when PG baseline coverage insufficient (safe-skip)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow(),
      daddyCtx({ coverageOk: false, baselineHoursWithData: 8 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks DADDY-like old mint dormant → sudden vol1h spike (4Cnk9EPn RCA)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(baseCfg(), baseRow(), daddyCtx());
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('old_mint_sudden_volume_spike:'))).toBe(true);
    expect(r.features.vol1hSpikeRatio).toBeGreaterThanOrEqual(5);
  });

  it('passes normal young pump with sustained volume (no dormant baseline)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({
        mint: 'YoungPump111111111111111111111111111111111',
        token_age_min: 2 * 1440,
        volume_1h: 80_000,
        volume_5m: 15_000,
      }),
      daddyCtx({
        dormantHourFraction: 0.2,
        baselineMedianVol1hUsd: 45_000,
        baselineP90Vol1hUsd: 60_000,
        recentMaxVol1hUsd: 80_000,
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes old mint when spike ratio too small', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg({ oldMintDormantVolSpikeVol1hRatioMin: 20 }),
      baseRow({ volume_1h: 12_000 }),
      daddyCtx({ recentMaxVol1hUsd: 12_000, baselineP90Vol1hUsd: 8000 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes old mint when baseline was not mostly dormant', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow(),
      daddyCtx({ dormantHourFraction: 0.4 }),
    );
    expect(r.blocked).toBe(false);
  });
});
