import { describe, expect, it } from 'vitest';
import type { DipContextByWindows } from '../src/papertrader/dip-detector.js';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  computeNearMissDipGap,
  selectNearMissDipMintSet,
} from '../src/papertrader/discovery/near-miss-dip-jupiter-refresh.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function row(mint: string, priceUsd: number): SnapshotCandidateRow {
  return {
    mint,
    symbol: 'T',
    source: 'pumpswap',
    price_usd: priceUsd,
    token_age_min: 1000,
  } as SnapshotCandidateRow;
}

function dipMap(mint: string, highPx: number, windowMin: number): Map<string, DipContextByWindows> {
  const inner = new Map<number, { high_px: number; low_px: number }>();
  inner.set(windowMin, { high_px: highPx, low_px: highPx * 0.7 });
  return new Map([[mint, inner]]);
}

describe('near-miss dip jupiter refresh', () => {
  const cfg = loadPaperTraderConfig({ strategyId: 'live-oscar' });
  const win = cfg.dipLookbackWindowsMin[0] ?? 60;

  it('detects mint within gap of dipMinDropPct', () => {
    const high = 0.024;
    const targetGap = 2;
    const dipPct = cfg.dipMinDropPct + targetGap;
    const price = high * (1 + dipPct / 100);
    const gap = computeNearMissDipGap(cfg, row('m1', price), dipMap('m1', high, win).get('m1'));
    expect(gap).not.toBeNull();
    expect(gap!.gapPct).toBeCloseTo(targetGap, 1);
    expect(gap!.gapPct).toBeLessThanOrEqual(cfg.priorityDiscoveryNearMissJupiterGapPct);
  });

  it('ignores mint already deep enough', () => {
    const high = 0.024;
    const price = high * (1 + (cfg.dipMinDropPct - 1) / 100);
    const gap = computeNearMissDipGap(cfg, row('m2', price), dipMap('m2', high, win).get('m2'));
    expect(gap).toBeNull();
  });

  it('ignores mint too far from threshold', () => {
    const high = 0.024;
    const price = high * (1 + (cfg.dipMinDropPct + cfg.priorityDiscoveryNearMissJupiterGapPct + 1) / 100);
    const gap = computeNearMissDipGap(cfg, row('m3', price), dipMap('m3', high, win).get('m3'));
    expect(gap).toBeNull();
  });

  it('selectNearMissDipMintSet skips priority-refreshed mints', () => {
    const high = 0.024;
    const price = high * (1 + (cfg.dipMinDropPct + 2) / 100);
    const m = 'm4';
    const map = dipMap(m, high, win);
    const selected = selectNearMissDipMintSet(cfg, [row(m, price)], map, new Set([m]));
    expect(selected.size).toBe(0);
  });
});
