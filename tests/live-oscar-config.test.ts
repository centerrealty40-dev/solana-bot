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
    expect(cfg.liveReconcileBlockMaxMs).toBe(0);
  });

  it('parses LIVE_CAPITAL_ROTATE_ENABLED and LIVE_PHASE5_FREE_SOL_GATE_ENABLED', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.LIVE_CAPITAL_ROTATE_ENABLED;
    delete process.env.LIVE_PHASE5_FREE_SOL_GATE_ENABLED;
    const d = loadLiveOscarConfig();
    expect(d.liveCapitalRotateEnabled).toBe(false);
    expect(d.livePhase5FreeSolGateEnabled).toBe(false);
    process.env.LIVE_CAPITAL_ROTATE_ENABLED = '1';
    process.env.LIVE_PHASE5_FREE_SOL_GATE_ENABLED = '1';
    const e = loadLiveOscarConfig();
    expect(e.liveCapitalRotateEnabled).toBe(true);
    expect(e.livePhase5FreeSolGateEnabled).toBe(true);
    delete process.env.LIVE_CAPITAL_ROTATE_ENABLED;
    delete process.env.LIVE_PHASE5_FREE_SOL_GATE_ENABLED;
  });

  it('loads live BTC gate + SOL equity defaults', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.LIVE_BTC_GATE_ENABLED;
    const c = loadLiveOscarConfig();
    expect(c.liveBtcGateEnabled).toBe(true);
    expect(c.liveBtcGateMaxStaleMs).toBe(900_000);
    expect(c.liveBtcBlockNewBuys1hDrawdownPct).toBe(2.5);
    expect(c.liveBtcBlockNewBuys4hDrawdownPct).toBe(5);
    expect(c.liveMinWalletSolEquityUsd).toBeUndefined();
    process.env.LIVE_BTC_GATE_ENABLED = '0';
    expect(loadLiveOscarConfig().liveBtcGateEnabled).toBe(false);
    delete process.env.LIVE_BTC_GATE_ENABLED;
    process.env.LIVE_MIN_WALLET_SOL_EQUITY_USD = '22';
    expect(loadLiveOscarConfig().liveMinWalletSolEquityUsd).toBe(22);
    delete process.env.LIVE_MIN_WALLET_SOL_EQUITY_USD;
  });

  it('parses LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS (0 disables)', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS;
    expect(loadLiveOscarConfig().livePostCloseTailSweepDelayMs).toBe(60_000);
    process.env.LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS = '0';
    expect(loadLiveOscarConfig().livePostCloseTailSweepDelayMs).toBe(0);
    process.env.LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS = '120000';
    expect(loadLiveOscarConfig().livePostCloseTailSweepDelayMs).toBe(120_000);
  });

  it('parses LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD = '7.5';
    expect(loadLiveOscarConfig().liveSkipBuyOpenIfWalletMintMinUsd).toBe(7.5);
    delete process.env.LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD;
    expect(loadLiveOscarConfig().liveSkipBuyOpenIfWalletMintMinUsd).toBe(0);
  });

  it('keeps periodic stale-open force-close disabled unless explicitly enabled', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED;

    expect(loadLiveOscarConfig().livePeriodicStuckForceCloseEnabled).toBe(false);

    process.env.LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED = '1';
    expect(loadLiveOscarConfig().livePeriodicStuckForceCloseEnabled).toBe(true);
  });

  it('parses LIVE_RECONCILE_BLOCK_MAX_MS', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    process.env.LIVE_RECONCILE_BLOCK_MAX_MS = '3600000';

    const cfg = loadLiveOscarConfig();
    expect(cfg.liveReconcileBlockMaxMs).toBe(3_600_000);
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

  it('parses LIVE_JUPITER_PRIORITY_MAX_SOL and LIVE_JUPITER_SWAP_PRIORITY_LEVEL', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    process.env.LIVE_JUPITER_PRIORITY_MAX_SOL = '0.0001';
    delete process.env.LIVE_JUPITER_PRIORITY_MAX_LAMPORTS;
    delete process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL;
    let cfg = loadLiveOscarConfig();
    expect(cfg.liveJupiterPriorityMaxLamports).toBe(100_000);
    expect(cfg.liveJupiterSwapPriorityLevel).toBe('medium');

    process.env.LIVE_JUPITER_PRIORITY_MAX_LAMPORTS = '200000';
    delete process.env.LIVE_JUPITER_PRIORITY_MAX_SOL;
    cfg = loadLiveOscarConfig();
    expect(cfg.liveJupiterPriorityMaxLamports).toBe(200_000);

    process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL = 'high';
    cfg = loadLiveOscarConfig();
    expect(cfg.liveJupiterSwapPriorityLevel).toBe('high');
    delete process.env.LIVE_JUPITER_PRIORITY_MAX_LAMPORTS;
    delete process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL;
    delete process.env.LIVE_JUPITER_PRIORITY_MAX_SOL;
    cfg = loadLiveOscarConfig();
    expect(cfg.liveJupiterPriorityMaxLamports).toBeUndefined();
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

  it('parses signal lab env defaults and rejects path collision with live / parity journals', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.SIGNAL_LAB_ENABLED;
    delete process.env.SIGNAL_LAB_SAMPLE_PCT;
    delete process.env.SIGNAL_LAB_PATH;
    delete process.env.SIGNAL_LAB_ALT_PROBE_FRACTION;

    const cfg = loadLiveOscarConfig();
    expect(cfg.signalLabEnabled).toBe(false);
    expect(cfg.signalLabSamplePct).toBe(25);
    expect(cfg.signalLabPath).toContain('signal-lab.jsonl');
    expect(cfg.signalLabAltProbeFraction).toBe(0);

    process.env.SIGNAL_LAB_ENABLED = '1';
    process.env.SIGNAL_LAB_SAMPLE_PCT = '50';
    process.env.SIGNAL_LAB_ALT_PROBE_FRACTION = '0.6';
    process.env.SIGNAL_LAB_PATH = '/tmp/signal-lab-test.jsonl';
    const b = loadLiveOscarConfig();
    expect(b.signalLabEnabled).toBe(true);
    expect(b.signalLabSamplePct).toBe(50);
    expect(b.signalLabAltProbeFraction).toBeCloseTo(0.6, 5);

    process.env.SIGNAL_LAB_PATH = '/tmp/live-test.jsonl';
    expect(() => loadLiveOscarConfig()).toThrow(/SIGNAL_LAB_PATH must differ from LIVE_TRADES_PATH/);

    process.env.SIGNAL_LAB_PATH = '/tmp/paper-test.jsonl';
    expect(() => loadLiveOscarConfig()).toThrow(/SIGNAL_LAB_PATH must differ from LIVE_PARITY_PAPER_TRADES_PATH/);

    delete process.env.SIGNAL_LAB_ENABLED;
    delete process.env.SIGNAL_LAB_SAMPLE_PCT;
    delete process.env.SIGNAL_LAB_PATH;
    delete process.env.SIGNAL_LAB_ALT_PROBE_FRACTION;
  });

  it('parses MTM shadow env defaults and rejects collisions with live / parity / signal-lab paths', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.MTM_SHADOW_ENABLED;
    delete process.env.MTM_SHADOW_SAMPLE_PCT;
    delete process.env.MTM_SHADOW_PATH;
    delete process.env.MTM_SHADOW_ALT_FRACTION;
    process.env.SIGNAL_LAB_PATH = '/tmp/signal-lab-test.jsonl';

    const cfg = loadLiveOscarConfig();
    expect(cfg.mtmShadowEnabled).toBe(false);
    expect(cfg.mtmShadowSamplePct).toBe(12);
    expect(cfg.mtmShadowPath).toContain('mtm-shadow.jsonl');
    expect(cfg.mtmShadowAltFraction).toBe(0);

    process.env.MTM_SHADOW_ENABLED = '1';
    process.env.MTM_SHADOW_SAMPLE_PCT = '20';
    process.env.MTM_SHADOW_ALT_FRACTION = '0.55';
    process.env.MTM_SHADOW_PATH = '/tmp/mtm-shadow-test.jsonl';
    const b = loadLiveOscarConfig();
    expect(b.mtmShadowEnabled).toBe(true);
    expect(b.mtmShadowSamplePct).toBe(20);
    expect(b.mtmShadowAltFraction).toBeCloseTo(0.55, 5);

    process.env.MTM_SHADOW_PATH = '/tmp/signal-lab-test.jsonl';
    expect(() => loadLiveOscarConfig()).toThrow(/MTM_SHADOW_PATH must differ from SIGNAL_LAB_PATH/);

    delete process.env.MTM_SHADOW_ENABLED;
    delete process.env.MTM_SHADOW_SAMPLE_PCT;
    delete process.env.MTM_SHADOW_PATH;
    delete process.env.MTM_SHADOW_ALT_FRACTION;
    delete process.env.SIGNAL_LAB_PATH;
  });

  it('parses live tracker Jupiter MTM guard and inter-mint delay env', () => {
    process.env.LIVE_STRATEGY_ENABLED = '0';
    process.env.LIVE_EXECUTION_MODE = 'dry_run';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    delete process.env.LIVE_WALLET_SECRET;
    delete process.env.LIVE_TRACKER_JUPITER_MAX_PREMIUM_OVER_SNAPSHOT_PCT;
    delete process.env.LIVE_TRACKER_INTER_MINT_DELAY_MS;

    const d = loadLiveOscarConfig();
    expect(d.liveTrackerJupiterMaxPremiumOverSnapshotPct).toBe(6);
    expect(d.liveTrackerInterMintDelayMs).toBe(120);

    process.env.LIVE_TRACKER_JUPITER_MAX_PREMIUM_OVER_SNAPSHOT_PCT = '0';
    process.env.LIVE_TRACKER_INTER_MINT_DELAY_MS = '55';
    const e = loadLiveOscarConfig();
    expect(e.liveTrackerJupiterMaxPremiumOverSnapshotPct).toBe(0);
    expect(e.liveTrackerInterMintDelayMs).toBe(55);
  });
});
