import { describe, expect, it } from 'vitest';
import {
  passesPresetCMcapBand,
  passesPresetCRetraceBand,
  presetCFilterReasons,
  PRESET_C_MAX_MCAP_USD,
  PRESET_C_MIN_MCAP_USD,
  evaluatePresetCCandidateGeometry,
} from '../src/preset-c/filters.js';

describe('preset C filters', () => {
  it('accepts mcap $1M–$15M and retrace 9–30%', () => {
    expect(passesPresetCMcapBand(1_500_000)).toBe(true);
    expect(passesPresetCMcapBand(15_000_000)).toBe(true);
    expect(passesPresetCMcapBand(999_999)).toBe(false);
    expect(passesPresetCMcapBand(15_000_001)).toBe(false);
    expect(passesPresetCRetraceBand(9)).toBe(true);
    expect(passesPresetCRetraceBand(30)).toBe(true);
    expect(passesPresetCRetraceBand(8.9)).toBe(false);
    expect(passesPresetCRetraceBand(30.1)).toBe(false);
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
    expect(PRESET_C_MIN_MCAP_USD).toBe(1_000_000);
    expect(PRESET_C_MAX_MCAP_USD).toBe(15_000_000);
    expect(presetCFilterReasons({ refMcapUsd: 0, retraceFromPeakPct: 10 })).toContain(
      'preset_c_mcap_missing',
    );
  });
});
