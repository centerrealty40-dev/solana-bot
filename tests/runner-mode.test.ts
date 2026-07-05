import { describe, it, expect } from 'vitest';
import { evaluateRunner, summariseRunnerPass } from '../src/papertrader/discovery/runner-mode.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

/**
 * 1.11.232: Runner Mode — параллельный путь discovery.
 *
 * Тестовые сценарии моделируются на реальных PG-данных за 20 мая 2026 (см. анализ
 * в чате): A1/WORLDCUP и MANIFEST/BC — должны проходить, TripleT — должен резаться
 * по anti-stale, TOESCOIN — должен проходить, но не уверенно (низкий vol_5m_avg).
 */

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    runnerModeEnabled: true,
    runnerMinPgSamples24h: 36,
    runnerMinVol1hUsd: 60_000,
    runnerMinVol12hUsd: 400_000,
    runnerVelocityMinX: 1.5,
    runnerMinVol5mPeak1hUsd: 20_000,
    runnerBs1hMin: 0.95,
    runnerBs12hMin: 1.0,
    runnerLiqVsP25Min: 0.85,
    runnerPriceHoldMin: 0.6,
    runnerMinMcapUsd: 1_000_000,
    runnerMaxMcapUsd: 30_000_000,
    runnerMinLiqUsd: 80_000,
    runnerStaleVolRatioMax: 0.5,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function row(overrides: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'M',
    symbol: 'X',
    source: 'pumpswap',
    price_usd: 0.005,
    liquidity_usd: 200_000,
    market_cap_usd: 5_000_000,
    volume_5m: 5_000,
    volume_1h: 100_000,
    ...overrides,
  } as unknown as SnapshotCandidateRow;
}

describe('runner_mode: hot runners (A1/WORLDCUP, MANIFEST)', () => {
  it('A1/WORLDCUP passes: vol_8h=$3.55M, peak_burst=$96k, bs≈1.13, mcap $5.7M', () => {
    const ctx = {
      vol1hUsd: 500_000,
      vol12hUsd: 3_550_000,
      vol24hUsd: 6_000_000,
      vol1hAvg24hUsd: 6_000_000 / 24,
      vol1hVelocity: 2.0,
      buys1h: 1500,
      sells1h: 1100,
      bs1h: 1.36,
      buys12h: 14_320,
      sells12h: 12_625,
      bs12h: 1.13,
      vol5mPeak1hUsd: 96_681,
      liqNowUsd: 244_820,
      liqP25_24hUsd: 200_000,
      liqP50_24hUsd: 240_000,
      mcapNowUsd: 5_737_429,
      mcapMax24hUsd: 6_207_915,
      priceNowUsd: 0.005738,
      priceMax24hUsd: 0.006208,
      pgSamples24h: 480,
      coverageOk: true,
    };
    const r = evaluateRunner(cfg(), row({ liquidity_usd: 244_820, market_cap_usd: 5_737_429, price_usd: 0.005738 }), ctx);
    expect(r.pass, JSON.stringify(r.reasons)).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('MANIFEST passes: vol_12h=$2.67M, peak_burst=$50k, bs≈1.28, mcap $20M', () => {
    const ctx = {
      vol1hUsd: 200_000,
      vol12hUsd: 2_670_000,
      vol24hUsd: 4_500_000,
      vol1hAvg24hUsd: 4_500_000 / 24,
      vol1hVelocity: 1.07,
      buys1h: 600,
      sells1h: 500,
      bs1h: 1.2,
      buys12h: 8_480,
      sells12h: 6_630,
      bs12h: 1.28,
      vol5mPeak1hUsd: 49_953,
      liqNowUsd: 387_119,
      liqP25_24hUsd: 350_000,
      liqP50_24hUsd: 380_000,
      mcapNowUsd: 20_063_249,
      mcapMax24hUsd: 22_422_106,
      priceNowUsd: 0.02229,
      priceMax24hUsd: 0.02491,
      pgSamples24h: 320,
      coverageOk: true,
    };
    const r = evaluateRunner(
      cfg({ runnerVelocityMinX: 1.0 }),
      row({ liquidity_usd: 387_119, market_cap_usd: 20_063_249, price_usd: 0.02229 }),
      ctx,
    );
    expect(r.pass, JSON.stringify(r.reasons)).toBe(true);
  });
});

describe('runner_mode: stale runners (TripleT-test)', () => {
  it('TripleT BLOCKED: 85 days old, vol_8h=$615k, sells>buys (0.54), peak_burst=$30k', () => {
    const ctx = {
      vol1hUsd: 50_000, // меньше чем (1_200_000/24) = 50_000 → ровно равно среднему часу
      vol12hUsd: 614_863,
      vol24hUsd: 1_200_000,
      vol1hAvg24hUsd: 1_200_000 / 24, // 50_000
      vol1hVelocity: 1.0,
      buys1h: 100,
      sells1h: 200, // SELL pressure
      bs1h: 0.5,
      buys12h: 1_858,
      sells12h: 3_414,
      bs12h: 0.54,
      vol5mPeak1hUsd: 30_623,
      liqNowUsd: 409_030,
      liqP25_24hUsd: 400_000,
      liqP50_24hUsd: 405_000,
      mcapNowUsd: 7_399_065,
      mcapMax24hUsd: 8_034_572,
      priceNowUsd: 0.007399,
      priceMax24hUsd: 0.008035,
      pgSamples24h: 350,
      coverageOk: true,
    };
    const r = evaluateRunner(cfg(), row({ liquidity_usd: 409_030, market_cap_usd: 7_399_065, price_usd: 0.007399 }), ctx);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('runner_bs1h<'))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('runner_bs12h<'))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('runner_velocity<'))).toBe(true);
  });

  it('declining attention BLOCKED by anti-stale ratio', () => {
    const ctx = {
      // vol_24h = 2.4M, vol_1h_avg = 100k, but actual vol_1h = 30k → ratio = 0.3 < 0.5
      vol1hUsd: 30_000,
      vol12hUsd: 600_000,
      vol24hUsd: 2_400_000,
      vol1hAvg24hUsd: 100_000,
      vol1hVelocity: 0.3,
      buys1h: 80,
      sells1h: 75,
      bs1h: 1.07,
      buys12h: 1_200,
      sells12h: 1_100,
      bs12h: 1.09,
      vol5mPeak1hUsd: 25_000,
      liqNowUsd: 200_000,
      liqP25_24hUsd: 180_000,
      liqP50_24hUsd: 195_000,
      mcapNowUsd: 5_000_000,
      mcapMax24hUsd: 5_500_000,
      priceNowUsd: 0.005,
      priceMax24hUsd: 0.0055,
      pgSamples24h: 280,
      coverageOk: true,
    };
    const r = evaluateRunner(cfg(), row(), ctx);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('runner_stale_vol1h<'))).toBe(true);
  });

  it('liq drained BLOCKED', () => {
    const ctx = {
      vol1hUsd: 200_000,
      vol12hUsd: 1_500_000,
      vol24hUsd: 3_000_000,
      vol1hAvg24hUsd: 125_000,
      vol1hVelocity: 1.6,
      buys1h: 300,
      sells1h: 250,
      bs1h: 1.2,
      buys12h: 4_000,
      sells12h: 3_500,
      bs12h: 1.14,
      vol5mPeak1hUsd: 40_000,
      liqNowUsd: 50_000, // упало
      liqP25_24hUsd: 200_000, // 50 / 200 = 0.25 → < 0.85
      liqP50_24hUsd: 240_000,
      mcapNowUsd: 4_000_000,
      mcapMax24hUsd: 4_500_000,
      priceNowUsd: 0.004,
      priceMax24hUsd: 0.0045,
      pgSamples24h: 400,
      coverageOk: true,
    };
    const r = evaluateRunner(cfg(), row({ liquidity_usd: 50_000, market_cap_usd: 4_000_000 }), ctx);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('runner_liq_vs_p25<') || x.startsWith('runner_liq<'))).toBe(true);
  });
});

describe('runner_mode: edge cases', () => {
  it('disabled — always false with single reason', () => {
    const r = evaluateRunner(cfg({ runnerModeEnabled: false }), row(), undefined);
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('runner_disabled');
  });

  it('no PG context (coverage=false) — blocks with coverage reason', () => {
    const r = evaluateRunner(cfg(), row(), undefined);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/^runner_pg_coverage</);
  });

  it('mcap < min — blocks even with strong vol', () => {
    const ctx = {
      vol1hUsd: 500_000,
      vol12hUsd: 3_000_000,
      vol24hUsd: 6_000_000,
      vol1hAvg24hUsd: 250_000,
      vol1hVelocity: 2.0,
      buys1h: 1000,
      sells1h: 800,
      bs1h: 1.25,
      buys12h: 10_000,
      sells12h: 8_500,
      bs12h: 1.18,
      vol5mPeak1hUsd: 80_000,
      liqNowUsd: 200_000,
      liqP25_24hUsd: 180_000,
      liqP50_24hUsd: 195_000,
      mcapNowUsd: 500_000, // < 1M
      mcapMax24hUsd: 600_000,
      priceNowUsd: 0.0005,
      priceMax24hUsd: 0.0006,
      pgSamples24h: 480,
      coverageOk: true,
    };
    const r = evaluateRunner(cfg(), row({ market_cap_usd: 500_000 }), ctx);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('runner_mcap<'))).toBe(true);
  });

  it('mcap > max — blocks (too late, no upside)', () => {
    const ctx = {
      vol1hUsd: 5_000_000,
      vol12hUsd: 50_000_000,
      vol24hUsd: 100_000_000,
      vol1hAvg24hUsd: 4_166_666,
      vol1hVelocity: 1.2,
      buys1h: 5000,
      sells1h: 4500,
      bs1h: 1.11,
      buys12h: 50_000,
      sells12h: 45_000,
      bs12h: 1.11,
      vol5mPeak1hUsd: 500_000,
      liqNowUsd: 2_000_000,
      liqP25_24hUsd: 1_800_000,
      liqP50_24hUsd: 1_950_000,
      mcapNowUsd: 50_000_000, // > 30M
      mcapMax24hUsd: 55_000_000,
      priceNowUsd: 0.05,
      priceMax24hUsd: 0.055,
      pgSamples24h: 1000,
      coverageOk: true,
    };
    const r = evaluateRunner(cfg(), row({ market_cap_usd: 50_000_000 }), ctx);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('runner_mcap>'))).toBe(true);
  });

  it('summariseRunnerPass produces compact human-readable line', () => {
    const f = {
      vol1hUsd: 500_000,
      vol12hUsd: 3_550_000,
      vol24hUsd: 6_000_000,
      vol1hAvg24hUsd: 250_000,
      vol1hVelocity: 2.0,
      buys1h: 1500,
      sells1h: 1100,
      bs1h: 1.36,
      buys12h: 14_320,
      sells12h: 12_625,
      bs12h: 1.13,
      vol5mPeak1hUsd: 96_681,
      liqNowUsd: 244_820,
      liqP25_24hUsd: 200_000,
      liqP50_24hUsd: 240_000,
      mcapNowUsd: 5_737_429,
      mcapMax24hUsd: 6_207_915,
      priceNowUsd: 0.005738,
      priceMax24hUsd: 0.006208,
      pgSamples24h: 480,
      coverageOk: true,
    };
    const s = summariseRunnerPass(f);
    expect(s).toContain('vol1h=$500k');
    expect(s).toContain('velocity=2.00x');
    expect(s).toContain('burst=$97k');
  });
});

describe('runner_mode: only_age_is_old is not a reason to skip', () => {
  it('3-month old token with strong impulse still passes (no age check)', () => {
    // Имитация: 3-х месячная монета (token_age_min = 130000) с большим импульсом сейчас.
    const ctx = {
      vol1hUsd: 600_000,
      vol12hUsd: 5_000_000,
      vol24hUsd: 8_000_000,
      vol1hAvg24hUsd: 333_333,
      vol1hVelocity: 1.8,
      buys1h: 2000,
      sells1h: 1500,
      bs1h: 1.33,
      buys12h: 20_000,
      sells12h: 18_000,
      bs12h: 1.11,
      vol5mPeak1hUsd: 120_000,
      liqNowUsd: 350_000,
      liqP25_24hUsd: 300_000,
      liqP50_24hUsd: 330_000,
      mcapNowUsd: 8_000_000,
      mcapMax24hUsd: 9_500_000,
      priceNowUsd: 0.008,
      priceMax24hUsd: 0.0095,
      pgSamples24h: 1400,
      coverageOk: true,
    };
    const r = evaluateRunner(
      cfg(),
      row({
        market_cap_usd: 8_000_000,
        liquidity_usd: 350_000,
        price_usd: 0.008,
        token_age_min: 130_000, // ~90 days
      } as Partial<SnapshotCandidateRow>),
      ctx,
    );
    expect(r.pass, JSON.stringify(r.reasons)).toBe(true);
  });
});
