import { describe, expect, it } from 'vitest';
import type { EvalDecision } from '../src/papertrader/discovery/dip-clones.js';
import {
  buildLiveOscarIntelBlockTelegramText,
  isLiveOscarIntelBlockNotifyDecision,
  liveOscarIntelBlockNotifyFingerprint,
  shouldNotifyLiveOscarIntelBlock,
} from '../src/papertrader/live-oscar-intel-notify.js';

const baseIntel = {
  mode: 'gate' as const,
  required: true,
  wouldBlock: true,
  blocked: true,
  swapCovered: true,
  tierGatesPassed: true,
  reasons: ['intel_BLOCK_TRADE:AbCdEfGh'],
  hits: [{ wallet: 'AbCdEfGh1234567890', kind: 'BLOCK_TRADE' as const }],
};

describe('live-oscar-intel-notify', () => {
  it('requires tierGatesPassed for notify decision', () => {
    expect(
      isLiveOscarIntelBlockNotifyDecision({
        liveOscarTradeLane: 'prod',
        reasons: ['prod_intel_bad_tag:AbCdEfGh'],
        oscarIntel: { ...baseIntel, tierGatesPassed: false },
      }),
    ).toBe(false);
    expect(
      isLiveOscarIntelBlockNotifyDecision({
        liveOscarTradeLane: 'runner_lite',
        reasons: ['runner_lite_intel_bad_tag:AbCdEfGh'],
        oscarIntel: baseIntel,
      }),
    ).toBe(true);
  });

  it('dedupes by intel fingerprint per lane+mint', () => {
    const cache = new Map<string, string>();
    const ig = baseIntel;
    expect(shouldNotifyLiveOscarIntelBlock(cache, 'runner_probe', 'mintA', ig)).toBe(true);
    cache.set('runner_probe:mintA', liveOscarIntelBlockNotifyFingerprint('runner_probe', ig));
    expect(shouldNotifyLiveOscarIntelBlock(cache, 'runner_probe', 'mintA', ig)).toBe(false);
  });

  it('builds prod lane telegram with metrics', () => {
    const d = {
      lane: 'post_migration',
      source: 'raydium',
      mint: 'mint12345678901234567890123456789012',
      symbol: 'PEPE',
      ageMin: 1200,
      pass: false,
      reasons: ['prod_intel_atlas_cluster:AbCdEfGh'],
      features: { market_cap_usd: 4_500_000, vol1h_usd: 90_000, price_usd: 1 },
      whale: null,
      liveOscarTradeLane: 'prod',
      oscarIntel: {
        ...baseIntel,
        blocked: true,
        reasons: ['atlas_cluster:AbCdEfGh'],
        hits: [{ wallet: 'AbCdEfGh1234567890', kind: 'atlas_cluster' as const }],
      },
    } as EvalDecision;
    const text = buildLiveOscarIntelBlockTelegramText({
      d,
      tradeLane: 'prod',
      escapeHtml: (s) => s,
      mintHrefHtml: (mint) => mint,
      fmtUsd: (v) => `$${Math.round(Number(v) / 1000)}K`,
    });
    expect(text).toContain('[ADVICE][live_oscar_intel_block]');
    expect(text).toContain('INTEL BLOCK');
    expect(text).toContain('вход запрещён');
    expect(text).toContain('не покупаем');
    expect(text).toContain('Lane: <code>prod</code>');
    expect(text).toContain('Vol 1h');
    expect(text).toContain('atlas cluster');
  });
});
