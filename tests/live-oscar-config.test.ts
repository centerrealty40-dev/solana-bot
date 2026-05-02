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

  it('parses Phase 5 optional risk/capital env (unset limits stay optional)', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    process.env.LIVE_KILL_AFTER_CONSEC_FAIL = '3';
    process.env.LIVE_ENTRY_MIN_FREE_MULT = '2.5';
    process.env.LIVE_FREE_SOL_BUFFER_LAMPORTS = '5000000';

    const cfg = loadLiveOscarConfig();
    expect(cfg.liveKillAfterConsecFail).toBe(3);
    expect(cfg.liveEntryMinFreeMult).toBeCloseTo(2.5, 5);
    expect(cfg.liveFreeSolBufferLamports).toBe(5_000_000);
    expect(cfg.liveMaxPositionUsd).toBeUndefined();
    expect(cfg.liveReplayOnBoot).toBe(true);
    expect(cfg.liveReconcileOnBoot).toBe(true);
    expect(cfg.liveReconcileMode).toBe('block_new');
    expect(cfg.liveReconcileToleranceAtoms).toBe(10_000);
  });

  it('rejects LIVE_RECONCILE_MODE=trust_chain without LIVE_RECONCILE_TRUST_CHAIN_ALLOWED', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    process.env.LIVE_RECONCILE_MODE = 'trust_chain';
    delete process.env.LIVE_RECONCILE_TRUST_CHAIN_ALLOWED;

    expect(() => loadLiveOscarConfig()).toThrow(/LIVE_RECONCILE_TRUST_CHAIN_ALLOWED/);
  });

  it('allows LIVE_RECONCILE_MODE=trust_chain when LIVE_RECONCILE_TRUST_CHAIN_ALLOWED=1', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    process.env.LIVE_RECONCILE_MODE = 'trust_chain';
    process.env.LIVE_RECONCILE_TRUST_CHAIN_ALLOWED = '1';

    const cfg = loadLiveOscarConfig();
    expect(cfg.liveReconcileMode).toBe('trust_chain');
  });

  it('defaults LIVE_QUOTE_MAX_AGE_MS to 8000; 0 disables', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;

    delete process.env.LIVE_QUOTE_MAX_AGE_MS;
    expect(loadLiveOscarConfig().liveQuoteMaxAgeMs).toBe(8000);

    process.env.LIVE_QUOTE_MAX_AGE_MS = '0';
    expect(loadLiveOscarConfig().liveQuoteMaxAgeMs).toBeUndefined();

    process.env.LIVE_QUOTE_MAX_AGE_MS = '2500';
    expect(loadLiveOscarConfig().liveQuoteMaxAgeMs).toBe(2500);
  });

  it('allows LIVE_EXECUTION_MODE=live when strategy enabled and wallet set (Phase 6)', () => {
    process.env.LIVE_STRATEGY_ENABLED = '1';
    process.env.LIVE_EXECUTION_MODE = 'live';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    process.env.LIVE_WALLET_SECRET = '[1,2,3]';

    const cfg = loadLiveOscarConfig();
    expect(cfg.executionMode).toBe('live');
    expect(cfg.liveConfirmCommitment).toBe('confirmed');
    expect(cfg.liveSimBeforeSend).toBe(true);
  });
});
