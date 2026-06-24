import { beforeAll, describe, it, expect } from 'vitest';

beforeAll(() => {
  process.env.PULLBACK_ALERT_SKIP_MAIN = '1';
  process.env.RETRACE_ALERT_SKIP_MAIN = '1';
});

describe('retrace/pullback channel dedupe keys', () => {
  it('imports', async () => {
    await import('../src/scripts/market-retrace-pullback-channel-dedupe.js');
    await import('../src/scripts/market-pullback-telegram-watch.js');
    await import('../src/scripts/market-pump-retrace-alert-watch.js');
  });
});

describe('retrace/pullback channel dedupe keys — mint+peak minute', () => {

  const mint = 'Bb4jR951QtVjeFAYFLBYXDSMKjbTDroCLPbFLdd7pump';
  const peak = new Date('2026-05-17T07:29:00.000Z');

  it('один ключ на mint+минуту пика для pullback и retrace', async () => {
    const { retracePullbackChannelEventKey: chFn } = await import(
      '../src/scripts/market-retrace-pullback-channel-dedupe.js',
    );
    const { pullbackAlertEventDedupeKey: pbFn } = await import(
      '../src/scripts/market-pullback-telegram-watch.js',
    );
    const { retraceAlertEventDedupeKey: rtFn } = await import(
      '../src/scripts/market-pump-retrace-alert-watch.js',
    );
    const ch = chFn(mint, peak);
    const pb = pbFn(mint, peak);
    const rt = rtFn(mint, peak);
    expect(pb).toBe(ch);
    expect(rt).toBe(ch);
  });

  it('разные пары DEX — тот же ключ при пике в пределах 15 мин', async () => {
    const { pullbackAlertEventDedupeKey: pbFn } = await import(
      '../src/scripts/market-pullback-telegram-watch.js',
    );
    const peakMeteora = new Date('2026-05-17T11:37:00.000Z');
    const peakPump = new Date('2026-05-17T11:38:00.000Z');
    expect(pbFn(mint, peakMeteora)).toBe(pbFn(mint, peakPump));
  });

  it('meteora 14:37 и pumpswap 14:38 МСК — один bucket', async () => {
    const { retracePullbackChannelEventKey: keyFn } = await import(
      '../src/scripts/market-retrace-pullback-channel-dedupe.js',
    );
    const peakMeteora = new Date('2026-05-17T11:37:00.000Z');
    const peakPump = new Date('2026-05-17T11:38:00.000Z');
    expect(keyFn(mint, peakMeteora)).toBe(keyFn(mint, peakPump));
  });
});

describe('reserveRetracePullbackChannelSlot', () => {
  it('второй watcher не получает слот для того же mint+bucket', async () => {
    const mod = await import('../src/scripts/market-retrace-pullback-channel-dedupe.js');
    const mint = `TestMint${Date.now()}`;
    const peak = new Date();
    expect(mod.reserveRetracePullbackChannelSlot(mint, peak, 'pullback')).toBe(true);
    expect(mod.reserveRetracePullbackChannelSlot(mint, peak, 'retrace')).toBe(false);
  });
});

describe('writeSpikeChannelDedupeEntry', () => {
  it('records spike dump for Preset C gate', async () => {
    const mod = await import('../src/scripts/market-retrace-pullback-channel-dedupe.js');
    const mint = `SpikeMint${Date.now()}`;
    const anchor = new Date('2026-06-24T10:45:00.000Z');
    mod.writeSpikeChannelDedupeEntry(mint, anchor, { spikeDumpPct: 9.45, refMcapUsd: 26_490_000 });
    const store = mod.readRetracePullbackChannelStore();
    const key = mod.retracePullbackChannelEventKey(mint, anchor);
    expect(store[key]?.source).toBe('spike');
    expect(store[key]?.spikeDumpPct).toBe(9.45);
  });
});
