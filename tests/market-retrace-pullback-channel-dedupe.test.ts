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

  it('разные пары DEX — тот же ключ при том же пике', async () => {
    const { pullbackAlertEventDedupeKey: pbFn } = await import(
      '../src/scripts/market-pullback-telegram-watch.js',
    );
    const k1 = pbFn(mint, peak);
    const k2 = pbFn(mint, new Date(peak.getTime() + 30_000));
    expect(k1).toBe(k2);
  });
});
