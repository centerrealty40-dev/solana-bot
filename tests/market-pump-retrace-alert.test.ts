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
