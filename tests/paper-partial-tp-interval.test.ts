import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';

describe('livePartialTpMinIntervalMs', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('defaults to 0 when unset', () => {
    delete process.env.PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS;
    delete process.env.LIVE_PARTIAL_TP_MIN_INTERVAL_MS;
    expect(loadPaperTraderConfig().livePartialTpMinIntervalMs).toBe(0);
  });

  it('reads PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS', () => {
    process.env.PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS = '5000';
    delete process.env.LIVE_PARTIAL_TP_MIN_INTERVAL_MS;
    expect(loadPaperTraderConfig().livePartialTpMinIntervalMs).toBe(5000);
  });

  it('falls back to LIVE_PARTIAL_TP_MIN_INTERVAL_MS', () => {
    delete process.env.PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS;
    process.env.LIVE_PARTIAL_TP_MIN_INTERVAL_MS = '7500';
    expect(loadPaperTraderConfig().livePartialTpMinIntervalMs).toBe(7500);
  });
});
