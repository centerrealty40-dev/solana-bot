import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluatePresetCScalpExitAction,
  isPresetCScalpExitPolicy,
  presetCScalpBreakevenExitEligible,
  presetCScalpDca2Due,
  presetCScalpDcaDue,
  presetCScalpKillEligible,
  presetCScalpSignalPnlFrac,
  stampPresetCScalpExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-preset-c-scalp.js';
import {
  isPresetCScalpModeEnabled,
  loadPresetCScalpConfig,
} from '../src/preset-c/scalp-config.js';
import {
  presetCScalpSignalDropPct,
  presetCScalpReadyToEvalDecision,
  presetCScalpFillTooDeep,
} from '../src/preset-c/scalp-pending.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function baseOpen(anchor = 1): OpenTrade {
  return {
    mint: 'Mint111111111111111111111111111111111111',
    symbol: 'TEST',
    lane: 'post_migration',
    source: 'raydium',
    dex: 'raydium',
    entryTs: Date.now(),
    entryMcUsd: anchor,
    metricType: 'mc',
    legs: [{ ts: Date.now(), price: anchor * 0.95, marketPrice: anchor * 0.95, sizeUsd: 100, reason: 'open' }],
    totalInvestedUsd: 100,
    avgEntry: anchor * 0.95,
    avgEntryMarket: anchor * 0.95,
    remainingFraction: 1,
    partialSells: [],
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    peakMcUsd: anchor,
    peakPnlPct: 0,
    trailingArmed: false,
    presetCScalpAnchorPriceUsd: anchor,
    liveExitPolicyId: 'preset_c_scalp_v1',
  };
}

describe('preset-c-scalp-config', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['PAPER_STRATEGY_ID', 'PRESET_C_SCALP_MODE', 'PRESET_C_SCALP_ENTRY_DROP_PCT']) {
      envBackup[k] = process.env[k];
    }
    process.env.PAPER_STRATEGY_ID = 'live-oscar-preset-c';
    process.env.PRESET_C_SCALP_MODE = '1';
    process.env.PRESET_C_SCALP_ENTRY_DROP_PCT = '10';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('enables scalp mode only for live-oscar-preset-c', () => {
    const cfg = loadPaperTraderConfig();
    expect(isPresetCScalpModeEnabled(cfg)).toBe(true);
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    const cfgMain = loadPaperTraderConfig();
    expect(isPresetCScalpModeEnabled(cfgMain)).toBe(false);
  });

  it('loads default entry drop 10% and kill 50%', () => {
    const scalp = loadPresetCScalpConfig();
    expect(scalp.entryDropPct).toBe(10);
    expect(scalp.dcaDropPct).toBe(10);
    expect(scalp.dca2DropPct).toBe(20);
    expect(scalp.entryUsd).toBe(50);
    expect(scalp.dcaUsd).toBe(0);
    expect(scalp.dca2Usd).toBe(0);
    expect(scalp.tp2Pct).toBe(5);
    expect(scalp.tpMidPct).toBe(10);
    expect(scalp.tp3Pct).toBe(15);
    expect(scalp.killPct).toBe(50);
  });

  it('allows staged-entry leg USD=0 when staged entry disabled (PM2 preset-c scalp)', () => {
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '0';
    expect(() => loadPaperTraderConfig()).not.toThrow();
  });
});

describe('preset-c-scalp-pending', () => {
  it('computes signal drop pct', () => {
    expect(presetCScalpSignalDropPct(100, 95)).toBeCloseTo(5, 6);
    expect(presetCScalpSignalDropPct(100, 90)).toBeCloseTo(10, 6);
  });

  it('builds eval decision for deferred open', () => {
    const d = presetCScalpReadyToEvalDecision({
      mint: 'abc',
      symbol: 'X',
      lane: 'post_migration',
      signalTs: 1,
      signalPriceUsd: 1,
      features: { price_usd: 0.95, snapshot_ts_ms: 2, liq_usd: 1e5, vol5m_usd: 0, vol1h_usd: 0, buys5m: 0, sells5m: 0, buy_sell_ratio_5m: null, holders: 1000, token_age_min: 600, dip_pct: 10, impulse_pct: 0, dip_lookback_min: null, market_cap_usd: 2e6 },
      expiresAtMs: 999,
      currentPriceUsd: 0.95,
      signalDropPct: 5,
    });
    expect(d.pass).toBe(true);
    expect(d.mint).toBe('abc');
    expect(d.features.price_usd).toBe(0.95);
  });
});

describe('preset-c-scalp-exit-policy', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['PAPER_STRATEGY_ID', 'PRESET_C_SCALP_MODE', 'PRESET_C_SCALP_DCA_USD']) {
      envBackup[k] = process.env[k];
    }
    process.env.PAPER_STRATEGY_ID = 'live-oscar-preset-c';
    process.env.PRESET_C_SCALP_MODE = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('stamps preset_c_scalp_v1 on open', () => {
    const cfg = loadPaperTraderConfig();
    const ot = baseOpen();
    delete ot.liveExitPolicyId;
    stampPresetCScalpExitPolicyOnOpen(ot, cfg, 1);
    expect(isPresetCScalpExitPolicy(ot)).toBe(true);
  });

  it('uses signal anchor for pnl levels', () => {
    const ot = baseOpen(100);
    expect(presetCScalpSignalPnlFrac(ot, 105)).toBeCloseTo(0.05, 6);
    expect(presetCScalpSignalPnlFrac(ot, 115)).toBeCloseTo(0.15, 6);
  });

  it('fires tp2 partial and arms trail at +5%', () => {
    const cfg = loadPaperTraderConfig();
    const ot = baseOpen(100);
    const action = evaluatePresetCScalpExitAction(ot, cfg, 105);
    expect(action.kind).toBe('partial');
    if (action.kind === 'partial') {
      expect(action.sellFraction).toBeCloseTo(0.5, 6);
      action.mark();
      expect(ot.presetCScalpTp5Taken).toBe(true);
      expect(ot.presetCScalpTrailArmed).toBe(true);
    }
  });

  it('fires tpMid partial at +10% after tp2 (50% of remainder)', () => {
    const cfg = loadPaperTraderConfig();
    const ot = baseOpen(100);
    ot.presetCScalpTp5Taken = true;
    ot.presetCScalpTrailArmed = true;
    ot.remainingFraction = 0.5;
    const action = evaluatePresetCScalpExitAction(ot, cfg, 110);
    expect(action.kind).toBe('partial');
    if (action.kind === 'partial') {
      expect(action.sellFraction).toBeCloseTo(0.5, 6);
      action.mark();
      expect(ot.presetCScalpTp10Taken).toBe(true);
    }
  });

  it('sequential partials: +5% then +10% leave 25% for +15% exit', () => {
    const cfg = loadPaperTraderConfig();
    const ot = baseOpen(100);
    ot.totalInvestedUsd = 200;
    ot.legs[0].sizeUsd = 200;

    const tp5 = evaluatePresetCScalpExitAction(ot, cfg, 105);
    expect(tp5.kind).toBe('partial');
    if (tp5.kind === 'partial') {
      tp5.mark();
      ot.remainingFraction *= 1 - tp5.sellFraction;
    }
    expect(ot.remainingFraction).toBeCloseTo(0.5, 6);

    const tp10 = evaluatePresetCScalpExitAction(ot, cfg, 110);
    expect(tp10.kind).toBe('partial');
    if (tp10.kind === 'partial') {
      tp10.mark();
      ot.remainingFraction *= 1 - tp10.sellFraction;
    }
    expect(ot.remainingFraction).toBeCloseTo(0.25, 6);

    const tp15 = evaluatePresetCScalpExitAction(ot, cfg, 115);
    expect(tp15.kind).toBe('full_exit');
    if (tp15.kind === 'full_exit') expect(tp15.reason).toBe('TP');
  });

  it('full exit at +15%', () => {
    const cfg = loadPaperTraderConfig();
    const ot = baseOpen(100);
    const action = evaluatePresetCScalpExitAction(ot, cfg, 115);
    expect(action.kind).toBe('full_exit');
    if (action.kind === 'full_exit') expect(action.reason).toBe('TP');
  });

  it('kill at -50% vs signal', () => {
    const ot = baseOpen(100);
    expect(presetCScalpKillEligible(ot, 49)).toBe(true);
  });

  it('breakeven exit at 0% vs avg after partial tp', () => {
    const ot = baseOpen(100);
    ot.presetCScalpTp5Taken = true;
    expect(presetCScalpBreakevenExitEligible(ot, ot.avgEntry)).toBe(true);
  });

  it('breakeven exit at 0% after tp10 partial', () => {
    const cfg = loadPaperTraderConfig();
    const ot = baseOpen(100);
    ot.presetCScalpTp5Taken = true;
    ot.presetCScalpTp10Taken = true;
    ot.remainingFraction = 0.25;
    const action = evaluatePresetCScalpExitAction(ot, cfg, ot.avgEntry);
    expect(action.kind).toBe('full_exit');
    if (action.kind === 'full_exit') expect(action.reason).toBe('BREAKEVEN_EXIT');
  });

  it('fires DCA1 at −10% from signal anchor when enabled', () => {
    process.env.PRESET_C_SCALP_DCA_USD = '100';
    const ot = baseOpen(100);
    expect(presetCScalpDcaDue(ot, 90)).toBe(true);
    expect(presetCScalpDcaDue(ot, 91)).toBe(false);
  });

  it('skips DCA1 when dcaUsd is 0', () => {
    process.env.PRESET_C_SCALP_DCA_USD = '0';
    const ot = baseOpen(100);
    expect(presetCScalpDcaDue(ot, 90)).toBe(false);
  });

  it('fires DCA2 at −20% without DCA1 when DCA1 disabled', () => {
    process.env.PRESET_C_SCALP_DCA_USD = '0';
    process.env.PRESET_C_SCALP_DCA2_USD = '150';
    const ot = baseOpen(100);
    expect(presetCScalpDca2Due(ot, 80)).toBe(true);
    expect(presetCScalpDca2Due(ot, 81)).toBe(false);
    ot.presetCScalpDca2LegDone = true;
    expect(presetCScalpDca2Due(ot, 80)).toBe(false);
  });

  it('skips DCA2 when dca2Usd is 0 (single entry)', () => {
    process.env.PRESET_C_SCALP_DCA_USD = '0';
    process.env.PRESET_C_SCALP_DCA2_USD = '0';
    const ot = baseOpen(100);
    expect(presetCScalpDca2Due(ot, 80)).toBe(false);
  });

  it('fires DCA2 at −20% only after DCA1 when DCA1 enabled', () => {
    process.env.PRESET_C_SCALP_DCA_USD = '100';
    process.env.PRESET_C_SCALP_DCA2_USD = '150';
    const ot = baseOpen(100);
    expect(presetCScalpDca2Due(ot, 80)).toBe(false);
    ot.presetCScalpDcaLegDone = true;
    expect(presetCScalpDca2Due(ot, 80)).toBe(true);
    expect(presetCScalpDca2Due(ot, 81)).toBe(false);
    ot.presetCScalpDca2LegDone = true;
    expect(presetCScalpDca2Due(ot, 80)).toBe(false);
  });
});
