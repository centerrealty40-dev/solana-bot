import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordJupiter429Event,
  resetJupiter429MonitorForTests,
} from '../src/core/jupiter-429-monitor.js';
import * as jupiterAlerts from '../src/core/telegram/jupiter-alerts.js';

describe('jupiter-429-monitor', () => {
  const envBackup = { ...process.env };
  let burstSpy: ReturnType<typeof vi.spyOn>;
  let exhaustSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.JUPITER_429_BURST_TELEGRAM = '1';
    process.env.JUPITER_429_EXHAUST_TELEGRAM = '1';
    process.env.JUPITER_429_BURST_THRESHOLD = '3';
    process.env.JUPITER_429_BURST_WINDOW_MS = '60000';
    process.env.JUPITER_429_BURST_COOLDOWN_MS = '0';
    process.env.JUPITER_429_EXHAUST_COOLDOWN_MS = '0';
    resetJupiter429MonitorForTests();
    burstSpy = vi.spyOn(jupiterAlerts, 'notifyJupiter429RateLimitBurst').mockResolvedValue(undefined);
    exhaustSpy = vi
      .spyOn(jupiterAlerts, 'notifyJupiterQuoteRateLimitExhausted')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it('fires burst alert after threshold 429 events in window', () => {
    recordJupiter429Event({ source: 'quote' });
    recordJupiter429Event({ source: 'quote' });
    expect(burstSpy).not.toHaveBeenCalled();
    recordJupiter429Event({ source: 'swap' });
    expect(burstSpy).toHaveBeenCalledTimes(1);
    expect(burstSpy.mock.calls[0]![0]).toMatchObject({
      eventsInWindow: 3,
      bySource: { quote: 2, swap: 1, price: 0 },
    });
  });

  it('fires exhaustion alert when retries exhausted', () => {
    recordJupiter429Event({ source: 'quote', exhausted: true, retriesAttempted: 9 });
    expect(exhaustSpy).toHaveBeenCalledTimes(1);
    expect(exhaustSpy.mock.calls[0]![0]).toMatchObject({
      source: 'quote',
      retriesAttempted: 9,
    });
  });

  it('respects JUPITER_429_BURST_TELEGRAM=0', () => {
    process.env.JUPITER_429_BURST_TELEGRAM = '0';
    for (let i = 0; i < 5; i++) recordJupiter429Event({ source: 'quote' });
    expect(burstSpy).not.toHaveBeenCalled();
  });
});
