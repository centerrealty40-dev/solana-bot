import { describe, expect, it } from 'vitest';
import type { EvalDecision } from '../src/papertrader/discovery/dip-clones.js';
import {
  buildRunnerProbeIntelSkipTelegramText,
  formatIntelHitLine,
  isRunnerProbeIntelSkipDecision,
  runnerProbeIntelSkipReasons,
} from '../src/papertrader/runner-probe-intel-notify.js';

const baseDecision = {
  lane: 'post_migration',
  source: 'raydium',
  mint: 'mint12345678901234567890123456789012',
  symbol: 'TEST',
  ageMin: 800,
  pass: false,
  features: { market_cap_usd: 2_000_000, price_usd: 1 },
  whale: null,
  liveOscarTradeLane: 'runner_probe',
  positionSource: 'runner_probe',
} as EvalDecision;

describe('runner-probe-intel-notify', () => {
  it('detects intel skip reasons', () => {
    const reasons = [
      'runner_probe_intel_shadow_would_block',
      'runner_probe_intel_intel_BLOCK_TRADE:AbCdEfGh',
    ];
    expect(runnerProbeIntelSkipReasons(reasons)).toHaveLength(2);
    expect(isRunnerProbeIntelSkipDecision({ reasons, oscarIntel: undefined })).toBe(true);
  });

  it('formats intel hit with wallet and kind', () => {
    const line = formatIntelHitLine({
      wallet: 'AbCdEfGh1234567890',
      kind: 'scam_farm_meta',
    });
    expect(line).toContain('scam_farm_meta');
    expect(line).toContain('AbCdEfGh1234567890');
  });

  it('builds telegram text with ADVICE tag and hits', () => {
    const d: EvalDecision = {
      ...baseDecision,
      reasons: [
        'runner_probe_intel_intel_BLOCK_TRADE:AbCdEfGh',
        'runner_probe_rank_crowded_out',
      ],
      oscarIntel: {
        mode: 'gate',
        required: true,
        wouldBlock: true,
        blocked: true,
        swapCovered: true,
        reasons: ['intel_BLOCK_TRADE:AbCdEfGh'],
        hits: [{ wallet: 'AbCdEfGh1234567890', kind: 'BLOCK_TRADE' }],
      },
    };
    const text = buildRunnerProbeIntelSkipTelegramText({
      d,
      escapeHtml: (s) => s,
      mintHrefHtml: (mint) => mint,
      fmtUsd: () => '$2.0M',
    });
    expect(text).toContain('[ADVICE][runner_probe_intel]');
    expect(text).toContain('заблокирована');
    expect(text).toContain('BLOCK_TRADE');
    expect(text).toContain('runner_probe_rank_crowded_out');
  });

  it('shadow would-block message when not hard blocked', () => {
    const d: EvalDecision = {
      ...baseDecision,
      pass: true,
      reasons: ['runner_probe_intel_shadow_would_block', 'runner_probe_intel_atlas_cluster:AbCdEfGh'],
      oscarIntel: {
        mode: 'shadow',
        required: true,
        wouldBlock: true,
        blocked: false,
        swapCovered: true,
        reasons: ['atlas_cluster:AbCdEfGh'],
        hits: [{ wallet: 'AbCdEfGh1234567890', kind: 'atlas_cluster' }],
      },
    };
    const text = buildRunnerProbeIntelSkipTelegramText({
      d,
      escapeHtml: (s) => s,
      mintHrefHtml: (mint) => mint,
      fmtUsd: () => '$2.0M',
    });
    expect(text).toContain('заблокировал бы');
    expect(text).toContain('atlas cluster');
  });
});
