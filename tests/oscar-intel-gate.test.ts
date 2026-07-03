import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateOscarIntelGateForRunnerProbe,
  resolveOscarIntelModeForRunnerProbe,
} from '../src/papertrader/discovery/oscar-intel-gate.js';
import * as smartLotteryIntel from '../src/papertrader/discovery/smart-lottery-intel.js';

describe('oscar-intel-gate runner_probe lane mode', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'LIVE_OSCAR_INTEL_ENABLED',
      'LIVE_OSCAR_INTEL_MODE',
      'LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE',
      'LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED',
      'PAPER_RUNNER_PROBE_12H_INTEL_REQUIRED',
      'PAPER_RUNNER_PROBE_MAX_AGE_MIN',
    ]) {
      envBackup[k] = process.env[k];
    }
    process.env.LIVE_OSCAR_INTEL_ENABLED = '1';
    process.env.LIVE_OSCAR_INTEL_MODE = 'shadow';
    process.env.LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE = 'gate';
    process.env.LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED = '1';
    process.env.PAPER_RUNNER_PROBE_12H_INTEL_REQUIRED = '1';
    process.env.PAPER_RUNNER_PROBE_MAX_AGE_MIN = '2880';
    vi.spyOn(smartLotteryIntel, 'evaluateSmartLotteryIntelGate').mockResolvedValue({
      ok: false,
      reasons: ['intel_BLOCK_TRADE:AbCdEfGh'],
      swapCovered: true,
      hits: [{ wallet: 'AbCdEfGh1234567890', kind: 'BLOCK_TRADE' }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolveOscarIntelModeForRunnerProbe prefers lane override', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveOscarIntelModeForRunnerProbe(cfg)).toBe('gate');
  });

  it('gate mode on runner_probe blocks when intel fails', async () => {
    const cfg = loadPaperTraderConfig();
    const ig = await evaluateOscarIntelGateForRunnerProbe('mint12345678901234567890123456789012', cfg, 800);
    expect(ig.required).toBe(true);
    expect(ig.mode).toBe('gate');
    expect(ig.wouldBlock).toBe(true);
    expect(ig.blocked).toBe(true);
    expect(ig.hits[0]?.kind).toBe('BLOCK_TRADE');
  });

  it('global shadow does not block runner_probe when lane override is gate', async () => {
    process.env.LIVE_OSCAR_INTEL_MODE = 'shadow';
    process.env.LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE = 'gate';
    const cfg = loadPaperTraderConfig();
    const ig = await evaluateOscarIntelGateForRunnerProbe('mint12345678901234567890123456789012', cfg, 800);
    expect(ig.mode).toBe('gate');
    expect(ig.blocked).toBe(true);
  });

  it('falls back to global mode when lane override unset', async () => {
    delete process.env.LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE;
    const cfg = loadPaperTraderConfig();
    expect(resolveOscarIntelModeForRunnerProbe(cfg)).toBe('shadow');
    const ig = await evaluateOscarIntelGateForRunnerProbe('mint12345678901234567890123456789012', cfg, 800);
    expect(ig.mode).toBe('shadow');
    expect(ig.wouldBlock).toBe(true);
    expect(ig.blocked).toBe(false);
  });
});
