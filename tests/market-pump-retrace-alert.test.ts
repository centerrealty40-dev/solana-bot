import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.RETRACE_ALERT_SKIP_MAIN = '1';
});

describe('findPumpRetraceFromBars', () => {
  it('находит +10% от дна и -12% от пика (оба порога выполнены)', async () => {
    const mod = await import('../src/scripts/market-pump-retrace-alert-watch.js');
    const t0 = new Date('2026-01-01T12:00:00Z');
    const bars = [
      { ts: new Date(t0.getTime() + 0 * 60_000), px: 1.0, mcapUsd: 2e6 },
      { ts: new Date(t0.getTime() + 1 * 60_000), px: 1.07, mcapUsd: 2e6 },
      { ts: new Date(t0.getTime() + 2 * 60_000), px: 1.12, mcapUsd: 2e6 },
      { ts: new Date(t0.getTime() + 3 * 60_000), px: 0.98, mcapUsd: 2e6 },
    ];
    const nowMs = new Date(t0.getTime() + 3 * 60_000 + 30_000).getTime();
    const pick = mod.findPumpRetraceFromBars(bars, 6, 10, nowMs, 15);
    expect(pick).not.toBeNull();
    if (!pick) return;
    expect(pick.pumpPct).toBeGreaterThanOrEqual(6);
    expect(pick.retracePct).toBeGreaterThanOrEqual(10);
  });

  it('откат 5% — не проходит при minRetrace=10', async () => {
    const mod = await import('../src/scripts/market-pump-retrace-alert-watch.js');
    const t0 = new Date('2026-01-01T12:00:00Z');
    const bars = [
      { ts: new Date(t0.getTime() + 0 * 60_000), px: 1.0, mcapUsd: null },
      { ts: new Date(t0.getTime() + 1 * 60_000), px: 1.1, mcapUsd: null },
      { ts: new Date(t0.getTime() + 2 * 60_000), px: 1.045, mcapUsd: null },
    ];
    const nowMs = new Date(t0.getTime() + 2 * 60_000).getTime();
    const pick = mod.findPumpRetraceFromBars(bars, 6, 10, nowMs, 15);
    expect(pick).toBeNull();
  });

  it('устаревший бар k — не матчится', async () => {
    const mod = await import('../src/scripts/market-pump-retrace-alert-watch.js');
    const t0 = new Date('2026-01-01T12:00:00Z');
    const bars = [
      { ts: new Date(t0.getTime() + 0 * 60_000), px: 1.0, mcapUsd: null },
      { ts: new Date(t0.getTime() + 1 * 60_000), px: 1.1, mcapUsd: null },
      { ts: new Date(t0.getTime() + 2 * 60_000), px: 0.95, mcapUsd: null },
    ];
    const nowMs = new Date(t0.getTime() + 2 * 60_000 + 20 * 60_000).getTime();
    const pick = mod.findPumpRetraceFromBars(bars, 6, 10, nowMs, 15);
    expect(pick).toBeNull();
  });
});

describe('isPumpRetracePickDataGlitch — TOES-like dead pool', () => {
  it('отсекает micro valley + fake -100% при живой цене', async () => {
    const mod = await import('../src/scripts/market-pump-retrace-alert-watch.js');
    const t0 = new Date('2026-05-21T06:06:00Z');
    const bars = [
      { ts: new Date(t0.getTime() + 0 * 60_000), px: 0.000001284, mcapUsd: 1280 },
      { ts: new Date(t0.getTime() + 46 * 60_000), px: 0.007243, mcapUsd: 7_240_000 },
      { ts: new Date(t0.getTime() + 48 * 60_000), px: 1.044e-7, mcapUsd: 104 },
    ];
    const pick = mod.findPumpRetraceFromBars(bars, 6, 10, t0.getTime() + 48 * 60_000 + 30_000, 15);
    expect(pick).not.toBeNull();
    if (!pick) return;
    const meta = {
      base_mint: '6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump',
      pair_address: 'deadPool',
      px_now: 0.0072,
      ts_now: bars[2].ts,
      symbol: 'TOES',
      token_name: 'TOESCOIN',
      holder_count: null,
      liq_usd: 38_000,
      token_fdv_usd: 7_370_000,
    };
    expect(mod.isPumpRetracePickDataGlitch(pick, meta, bars, 7_370_000)).toBe(true);
  });

  it('реальный -15% пролив на canonical pool — не glitch', async () => {
    const sanity = await import('../src/scripts/market-retrace-sanity.js');
    expect(
      sanity.isRetraceContradictedByLatestSnapshot(1.0, 0.85, 0.86, 15),
    ).toBe(false);
    expect(
      sanity.isMatureTokenMicroValleyArtifact(2_000_000, 2_500_000, 2_400_000, 25),
    ).toBe(false);
  });
});
