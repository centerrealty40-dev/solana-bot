import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadLiveOscarConfig } from '../src/live/config.js';

describe('loadLiveOscarConfig (W8.0 p0)', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('loads disabled profile without wallet', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;

    const cfg = loadLiveOscarConfig();
    expect(cfg.strategyEnabled).toBe(false);
    expect(cfg.executionMode).toBe('dry_run');
    expect(cfg.liveTradesPath).toBe('/tmp/live-test.jsonl');
  });

  it('throws when live path equals parity paper path', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_TRADES_PATH = '/same/path.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/same/path.jsonl';

    expect(() => loadLiveOscarConfig()).toThrow(/must differ/);
  });

  it('requires wallet when enabled and simulate', () => {
    process.env.LIVE_STRATEGY_ENABLED = '1';
    process.env.LIVE_EXECUTION_MODE = 'simulate';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;

    expect(() => loadLiveOscarConfig()).toThrow(/LIVE_WALLET_SECRET/);
  });

  it('rejects LIVE_EXECUTION_MODE=live until Phase 6 when strategy enabled', () => {
    process.env.LIVE_STRATEGY_ENABLED = '1';
    process.env.LIVE_EXECUTION_MODE = 'live';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    process.env.LIVE_WALLET_SECRET = '[1,2,3]';

    expect(() => loadLiveOscarConfig()).toThrow(/Phase 6/);
  });
});
