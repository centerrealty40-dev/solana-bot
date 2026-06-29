import { describe, expect, it } from 'vitest';
import {
  passesPresetCMcapBand,
  passesPresetCSpikeMcapBand,
  passesPresetCRetraceBand,
  presetCFilterReasons,
  PRESET_C_MAX_MCAP_USD,
  PRESET_C_MIN_MCAP_USD,
  PRESET_C_SPIKE_MIN_MCAP_USD,
  evaluatePresetCCandidateGeometry,
  isPresetCMcapKnown,
} from '../src/preset-c/filters.js';

describe('preset C filters', () => {
  it('accepts mcap $3M–$30M and retrace 9–30%', () => {
    expect(passesPresetCMcapBand(5_000_000)).toBe(true);
    expect(passesPresetCMcapBand(30_000_000)).toBe(true);
    expect(passesPresetCMcapBand(2_999_999)).toBe(false);
    expect(passesPresetCMcapBand(30_000_001)).toBe(false);
    expect(passesPresetCRetraceBand(9)).toBe(true);
    expect(passesPresetCRetraceBand(30)).toBe(true);
    expect(passesPresetCRetraceBand(8.9)).toBe(false);
    expect(passesPresetCRetraceBand(30.1)).toBe(false);
  });

  it('rejects unknown or zero mcap (require known mcap ≥ $3M)', () => {
    expect(isPresetCMcapKnown(0)).toBe(false);
    expect(isPresetCMcapKnown(NaN)).toBe(false);
    expect(passesPresetCMcapBand(0)).toBe(false);
    expect(passesPresetCMcapBand(NaN)).toBe(false);
    expect(
      presetCFilterReasons({ refMcapUsd: 0, retraceFromPeakPct: 10 }),
    ).toContain('preset_c_mcap_below_3m');
    expect(
      presetCFilterReasons({ refMcapUsd: 0, retraceFromPeakPct: 5 }),
    ).toEqual([
      'preset_c_mcap_below_3m',
      'preset_c_retrace_outside_9_30pct',
    ]);
  });

  it('evaluatePresetCCandidateGeometry matches band', () => {
    const ok = evaluatePresetCCandidateGeometry({ refMcapUsd: 5_000_000, retraceFromPeakPct: 12 });
    expect(ok.pass).toBe(true);
    expect(ok.reasons).toHaveLength(0);

    const bad = evaluatePresetCCandidateGeometry({ refMcapUsd: 500_000, retraceFromPeakPct: 12 });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.some((r) => r.includes('mcap_below'))).toBe(true);
  });

  it('documents preset C mcap window constants', () => {
    expect(PRESET_C_MIN_MCAP_USD).toBe(3_000_000);
    expect(PRESET_C_SPIKE_MIN_MCAP_USD).toBeGreaterThanOrEqual(5_000_000);
    expect(PRESET_C_MAX_MCAP_USD).toBe(30_000_000);
  });

  it('spike mcap band requires $5M+ by default', () => {
    expect(passesPresetCSpikeMcapBand(4_000_000)).toBe(false);
    expect(passesPresetCSpikeMcapBand(5_000_000)).toBe(true);
    expect(passesPresetCMcapBand(4_000_000)).toBe(true);
  });
});
