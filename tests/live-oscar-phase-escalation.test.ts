import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  applyLiveOscarPhaseEscalation,
  computeDropFromScalpAnchor,
  evaluateScalpPhaseEscalationTrigger,
  liveOscarMintOpenSkipReasonForEscalation,
} from '../src/papertrader/live-oscar-phase-escalation.js';
import { liveOscarMintOpenSkipReason } from '../src/papertrader/live-oscar-scalp-wave.js';
import {
  scalpWaveEffectiveExitParams,
  stampScalpWaveExitPolicyOnOpen,
} from '../src/papertrader/executor/exit-policy-scalp-wave.js';
import { isWaveBExitPolicy } from '../src/papertrader/executor/exit-policy-wave-b.js';
import type { OpenTrade } from '../src/papertrader/types.js';

describe('live-oscar-phase-escalation', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED',
      'PAPER_LIVE_STAGED_ENTRY_ENABLED',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS',
      'PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT',
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_DIP_MIN_DROP_PCT = '-15';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_TIME_STOP_HOURS = '3';
    process.env.PAPER_LIVE_OSCAR_SCALP_WAVE_KILL_PCT = '0.1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '1300000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function scalpOpen(anchor = 1): OpenTrade {
    const ot = {
      mint: 'mintEsc',
      symbol: 'ESC',
      entryTs: Date.now() - 3_600_000,
      legs: [{ ts: Date.now() - 3_600_000, price: anchor, marketPrice: anchor, sizeUsd: 300, reason: 'open' }],
      avgEntry: anchor,
      avgEntryMarket: anchor,
      totalInvestedUsd: 300,
      partialSells: [],
      liveOscarTradeLane: 'scalp_wave',
      liveOscarMcapTier: 'scalp_wave',
      entryMarketCapUsd: 1_500_000,
    } as OpenTrade;
    const cfg = loadPaperTraderConfig();
    stampScalpWaveExitPolicyOnOpen(ot, cfg);
    return ot;
  }

  it('disables scalp kill — escalation replaces −10% killstop', () => {
    const cfg = loadPaperTraderConfig();
    const eff = scalpWaveEffectiveExitParams(cfg);
    expect(eff.dcaKillstop).toBe(0);
    const ot = scalpOpen();
    expect(ot.tpGridOverrides?.dcaKillstop).toBe(0);
  });

  it('deep dip past −15% from entry triggers escalation', () => {
    const cfg = loadPaperTraderConfig();
    const ot = scalpOpen(1);
    expect(computeDropFromScalpAnchor(ot, 0.84)).toBeCloseTo(-16, 1);
    expect(
      evaluateScalpPhaseEscalationTrigger({ cfg, ot, curPriceUsd: 0.84, ageHours: 0.5 }),
    ).toBe('deep_dip');
  });

  it('timestop without TP triggers escalation', () => {
    const cfg = loadPaperTraderConfig();
    const ot = scalpOpen(1);
    expect(
      evaluateScalpPhaseEscalationTrigger({ cfg, ot, curPriceUsd: 0.95, ageHours: 3.1 }),
    ).toBe('timestop_no_tp');
  });

  it('apply escalation: scalp_wave → prod lane + wave_b_v1 + staged entry', () => {
    const cfg = loadPaperTraderConfig();
    const ot = scalpOpen(1);
    const ok = applyLiveOscarPhaseEscalation({
      cfg,
      ot,
      trigger: 'deep_dip',
      curPriceUsd: 0.8,
      marketCapUsd: 1_500_000,
    });
    expect(ok).toBe(true);
    expect(ot.liveOscarPhaseEscalatedFrom).toBe('scalp_wave');
    expect(ot.liveOscarTradeLane).toBe('prod');
    expect(ot.liveOscarMcapTier).toBe('low');
    expect(isWaveBExitPolicy(ot)).toBe(true);
    expect(ot.liveStagedEntry).toBeDefined();
    expect(ot.liveStagedEntry?.entrySplitLeg1Ts).toBeGreaterThan(0);
  });

  it('mutex: prod eval on open scalp → phase_escalation_handoff (not lane_mint_mutex)', () => {
    const cfg = loadPaperTraderConfig();
    const open = new Map<string, OpenTrade>();
    open.set('mintA', { liveOscarTradeLane: 'scalp_wave', liveOscarMcapTier: 'scalp_wave' } as OpenTrade);
    expect(
      liveOscarMintOpenSkipReasonForEscalation({
        open,
        mint: 'mintA',
        incomingTradeLane: 'prod',
        cfg,
      }),
    ).toBe('phase_escalation_handoff');
    expect(
      liveOscarMintOpenSkipReason({
        open,
        mint: 'mintA',
        incomingTradeLane: 'prod',
        cfg,
      }),
    ).toBe('phase_escalation_handoff');
    expect(
      liveOscarMintOpenSkipReason({
        open,
        mint: 'mintA',
        incomingTradeLane: 'scalp_wave',
        cfg,
      }),
    ).toBe('already_open');
  });

  it('after escalation, same mint prod eval → already_open', () => {
    const cfg = loadPaperTraderConfig();
    const ot = scalpOpen(1);
    applyLiveOscarPhaseEscalation({ cfg, ot, trigger: 'deep_dip', curPriceUsd: 0.8 });
    const open = new Map([[ot.mint, ot]]);
    expect(
      liveOscarMintOpenSkipReason({ open, mint: ot.mint, incomingTradeLane: 'prod', cfg }),
    ).toBe('already_open');
  });
});
