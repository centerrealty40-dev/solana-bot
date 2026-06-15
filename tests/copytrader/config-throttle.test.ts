import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCopyTraderConfig } from '../../src/copytrader/config.js';

describe('copy-trader Jupiter throttle config', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.COPY_TRADER_TARGET_WALLET = '11111111111111111111111111111112';
    process.env.COPY_TRADER_RPC_URL = 'https://example-rpc.test';
    process.env.COPY_TRADER_EXECUTION_MODE = 'paper';
    process.env.COPY_TRADER_STRICT_ISOLATION = '0';
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('defaults min sell / dip quote intervals to 0', () => {
    delete process.env.COPY_TRADER_MIN_SELL_INTERVAL_MS;
    delete process.env.COPY_TRADER_ENTRY_DIP_JUPITER_MIN_INTERVAL_MS;
    const cfg = loadCopyTraderConfig();
    expect(cfg.minSellIntervalMs).toBe(0);
    expect(cfg.entryDipJupiterMinIntervalMs).toBe(0);
  });

  it('parses throttle env', () => {
    process.env.COPY_TRADER_MIN_SELL_INTERVAL_MS = '5000';
    process.env.COPY_TRADER_ENTRY_DIP_JUPITER_MIN_INTERVAL_MS = '12000';
    const cfg = loadCopyTraderConfig();
    expect(cfg.minSellIntervalMs).toBe(5000);
    expect(cfg.entryDipJupiterMinIntervalMs).toBe(12000);
  });
});
