import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  passesPresetCMcapBand,
  passesPresetCSpikeMcapBand,
  passesPresetCRetraceBand,
  passesPresetCEliteSpikeDumpBand,
  passesPresetCEliteSpikeSanity,
  passesPresetCEliteSpikeUtcWindow,
  presetCFilterReasons,
  presetCEliteSpikeFilterReasons,
  PRESET_C_MAX_MCAP_USD,
  PRESET_C_MIN_MCAP_USD,
  PRESET_C_SPIKE_MIN_MCAP_USD,
  PRESET_C_SPIKE_DUMP_PCT_MIN,
  PRESET_C_SPIKE_DUMP_PCT_MAX,
  PRESET_C_SPIKE_MAX_ABS_PCT,
  evaluatePresetCCandidateGeometry,
  isPresetCMcapKnown,
} from '../src/preset-c/filters.js';

describe('preset C filters', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'PRESET_C_SPIKE_MIN_MCAP_USD',
      'PRESET_C_ELITE_SPIKE_ENABLED',
      'PRESET_C_SPIKE_DUMP_PCT_MIN',
      'PRESET_C_SPIKE_DUMP_PCT_MAX',
      'PRESET_C_SPIKE_MAX_ABS_PCT',
      'PRESET_C_SPIKE_UTC_WINDOW_ENABLED',
      'PRESET_C_SPIKE_UTC_HOURS',
    ]) {
      envBackup[k] = process.env[k];
    }
    delete process.env.PRESET_C_SPIKE_MIN_MCAP_USD;
    process.env.PRESET_C_ELITE_SPIKE_ENABLED = '1';
    process.env.PRESET_C_SPIKE_UTC_WINDOW_ENABLED = '0';
    vi.resetModules();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  it('accepts mcap $3M–$30M and retrace 9–30%', async () => {
    const mod = await import('../src/preset-c/filters.js');
    expect(mod.passesPresetCMcapBand(5_000_000)).toBe(true);
    expect(mod.passesPresetCMcapBand(30_000_000)).toBe(true);
    expect(mod.passesPresetCMcapBand(2_999_999)).toBe(false);
    expect(mod.passesPresetCMcapBand(30_000_001)).toBe(false);
    expect(mod.passesPresetCRetraceBand(9)).toBe(true);
    expect(mod.passesPresetCRetraceBand(30)).toBe(true);
    expect(mod.passesPresetCRetraceBand(8.9)).toBe(false);
    expect(mod.passesPresetCRetraceBand(30.1)).toBe(false);
  });

  it('rejects unknown or zero mcap (require known mcap ≥ $3M)', async () => {
    const mod = await import('../src/preset-c/filters.js');
    expect(mod.isPresetCMcapKnown(0)).toBe(false);
    expect(mod.isPresetCMcapKnown(NaN)).toBe(false);
    expect(mod.passesPresetCMcapBand(0)).toBe(false);
    expect(mod.passesPresetCMcapBand(NaN)).toBe(false);
    expect(
      mod.presetCFilterReasons({ refMcapUsd: 0, retraceFromPeakPct: 10 }),
    ).toContain('preset_c_mcap_below_3m');
    expect(
      mod.presetCFilterReasons({ refMcapUsd: 0, retraceFromPeakPct: 5 }),
    ).toEqual([
      'preset_c_mcap_below_3m',
      'preset_c_retrace_outside_9_30pct',
    ]);
  });

  it('evaluatePresetCCandidateGeometry matches band', async () => {
    const mod = await import('../src/preset-c/filters.js');
    const ok = mod.evaluatePresetCCandidateGeometry({ refMcapUsd: 5_000_000, retraceFromPeakPct: 12 });
    expect(ok.pass).toBe(true);
    expect(ok.reasons).toHaveLength(0);

    const bad = mod.evaluatePresetCCandidateGeometry({ refMcapUsd: 500_000, retraceFromPeakPct: 12 });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.some((r) => r.includes('mcap_below'))).toBe(true);
  });

  it('documents preset C mcap window constants', async () => {
    const mod = await import('../src/preset-c/filters.js');
    expect(mod.PRESET_C_MIN_MCAP_USD).toBe(3_000_000);
    expect(mod.PRESET_C_SPIKE_MIN_MCAP_USD).toBe(3_000_000);
    expect(mod.PRESET_C_MAX_MCAP_USD).toBe(30_000_000);
  });

  it('spike mcap band accepts $3M+ by default (elite)', async () => {
    const mod = await import('../src/preset-c/filters.js');
    expect(mod.passesPresetCSpikeMcapBand(2_999_999)).toBe(false);
    expect(mod.passesPresetCSpikeMcapBand(3_000_000)).toBe(true);
    expect(mod.passesPresetCSpikeMcapBand(4_000_000)).toBe(true);
    expect(mod.passesPresetCMcapBand(4_000_000)).toBe(true);
  });

  it('elite spike dump band accepts 10–20% only', async () => {
    const mod = await import('../src/preset-c/filters.js');
    expect(mod.passesPresetCEliteSpikeDumpBand(9.9)).toBe(false);
    expect(mod.passesPresetCEliteSpikeDumpBand(10)).toBe(true);
    expect(mod.passesPresetCEliteSpikeDumpBand(15)).toBe(true);
    expect(mod.passesPresetCEliteSpikeDumpBand(20)).toBe(true);
    expect(mod.passesPresetCEliteSpikeDumpBand(20.1)).toBe(false);
    expect(mod.passesPresetCEliteSpikeDumpBand(30)).toBe(false);
  });

  it('elite spike sanity rejects |pct| >= 35%', async () => {
    const mod = await import('../src/preset-c/filters.js');
    expect(mod.passesPresetCEliteSpikeSanity(34.9)).toBe(true);
    expect(mod.passesPresetCEliteSpikeSanity(35)).toBe(false);
    expect(mod.passesPresetCEliteSpikeSanity(-35)).toBe(false);
  });

  it('elite spike UTC window defaults 12–18 inclusive start exclusive end', async () => {
    process.env.PRESET_C_SPIKE_UTC_WINDOW_ENABLED = '1';
    process.env.PRESET_C_SPIKE_UTC_HOURS = '12-18';
    vi.resetModules();
    const mod = await import('../src/preset-c/filters.js');
    const noonUtc = Date.UTC(2026, 5, 30, 12, 30);
    const before = Date.UTC(2026, 5, 30, 11, 59);
    const after = Date.UTC(2026, 5, 30, 18, 0);
    expect(mod.passesPresetCEliteSpikeUtcWindow(noonUtc)).toBe(true);
    expect(mod.passesPresetCEliteSpikeUtcWindow(before)).toBe(false);
    expect(mod.passesPresetCEliteSpikeUtcWindow(after)).toBe(false);
  });

  it('presetCEliteSpikeFilterReasons passes elite dump at $5M mcap', async () => {
    process.env.PRESET_C_SPIKE_UTC_WINDOW_ENABLED = '0';
    vi.resetModules();
    const mod = await import('../src/preset-c/filters.js');
    const ok = mod.presetCEliteSpikeFilterReasons({
      spikeDumpPct: 15,
      refMcapUsd: 5_000_000,
    });
    expect(ok).toEqual([]);

    const lowDump = mod.presetCEliteSpikeFilterReasons({
      spikeDumpPct: 9,
      refMcapUsd: 5_000_000,
    });
    expect(lowDump).toContain('preset_c_elite_spike_dump_outside_10_20pct');

    const glitch = mod.presetCEliteSpikeFilterReasons({
      spikeDumpPct: 40,
      refMcapUsd: 5_000_000,
    });
    expect(glitch.some((r) => r.includes('dump_outside') || r.includes('abs_pct'))).toBe(true);
  });

  it('exports elite spike env defaults', () => {
    expect(PRESET_C_SPIKE_DUMP_PCT_MIN).toBe(10);
    expect(PRESET_C_SPIKE_DUMP_PCT_MAX).toBe(20);
    expect(PRESET_C_SPIKE_MAX_ABS_PCT).toBe(35);
    expect(PRESET_C_SPIKE_MIN_MCAP_USD).toBe(3_000_000);
  });
});
