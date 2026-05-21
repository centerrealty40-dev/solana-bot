import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SPIKE_ALERT_SKIP_MAIN = '1';
  process.env.SPIKE_ALERT_MIN_LIQ_SHARE_OF_MINT_MAX = '0.1';
  process.env.SPIKE_ALERT_STALE_ZERO_VOL_JUMP_PCT = '30';
  process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN = '';
  process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID = '';
});

describe('market-spike pool quality filters', () => {
  it('isDeadPoolVsMintMaxLiq — Goblin-like dead meteora pool', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.isDeadPoolVsMintMaxLiq(38_000, 553_000, 0.1)).toBe(true);
    expect(mod.isDeadPoolVsMintMaxLiq(387_000, 553_000, 0.1)).toBe(false);
    expect(mod.isDeadPoolVsMintMaxLiq(60_000, 553_000, 0.1)).toBe(false);
  });

  it('isDeadPoolVsMintMaxLiq — disabled when share=0', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    expect(mod.isDeadPoolVsMintMaxLiq(38_000, 553_000, 0)).toBe(false);
  });

  it('isStaleZeroVolPriceJump — anchor bar vol5m=0 and big jump', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const t0 = new Date('2026-05-21T06:08:00Z');
    const t1 = new Date('2026-05-21T06:09:00Z');
    const bars = [
      { ts: t0, px: 0.007219, mcapUsd: 13_000_000, vol5m: 0 },
      { ts: t1, px: 0.01411, mcapUsd: 13_500_000, vol5m: 1200 },
    ];
    const pick = {
      pct: 95.46,
      anchorPx: 0.007219,
      pxNow: 0.01411,
      anchorMcapUsd: 13_000_000,
      nowMcapUsd: 13_500_000,
      anchorTs: t0,
      tsNew: t1,
      windowLabel: 'test',
      signalKind: 'consecutive' as const,
    };
    expect(mod.isStaleZeroVolPriceJump(bars, pick, 30)).toBe(true);
  });

  it('isStaleZeroVolPriceJump — anchor had volume → pass', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const t0 = new Date('2026-05-21T06:08:00Z');
    const t1 = new Date('2026-05-21T06:09:00Z');
    const bars = [
      { ts: t0, px: 0.007219, mcapUsd: 13_000_000, vol5m: 5000 },
      { ts: t1, px: 0.01411, mcapUsd: 13_500_000, vol5m: 1200 },
    ];
    const pick = {
      pct: 95.46,
      anchorPx: 0.007219,
      pxNow: 0.01411,
      anchorMcapUsd: 13_000_000,
      nowMcapUsd: 13_500_000,
      anchorTs: t0,
      tsNew: t1,
      windowLabel: 'test',
      signalKind: 'consecutive' as const,
    };
    expect(mod.isStaleZeroVolPriceJump(bars, pick, 30)).toBe(false);
  });

  it('buildMintMaxLiqFromLatestRows — max across pairs', async () => {
    const mod = await import('../src/scripts/market-spike-telegram-watch.js');
    const map = mod.buildMintMaxLiqFromLatestRows([
      { base_mint: 'mintA', liq_usd: 38_000 },
      { base_mint: 'mintA', liq_usd: 553_000 },
      { base_mint: 'mintB', liq_usd: 10_000 },
    ]);
    expect(map.get('mintA')).toBe(553_000);
    expect(map.get('mintB')).toBe(10_000);
  });
});

describe('live_daily_summary JSONL schema', () => {
  it('parses live_daily_summary event body', async () => {
    const { safeParseLiveEventBody } = await import('../src/live/events.js');
    const r = safeParseLiveEventBody({
      kind: 'live_daily_summary',
      fromMs: 1_700_000_000_000,
      toMs: 1_700_086_400_000,
      evals: 100,
      passes: 5,
      buyAttempts: 2,
      buyConfirmed: 1,
      sellConfirmed: 1,
      closedPositions: 1,
      netPnlUsd: -12.5,
      simErrCount: 0,
      stagedCooldownRearms: 0,
      autoDenylistAdds: 0,
      priorityFeeBoosts: 0,
      topBlockers: [{ reason: 'dip_no_window_pass', count: 80 }],
    });
    expect(r.success).toBe(true);
  });
});
