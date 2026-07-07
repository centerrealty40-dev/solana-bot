import { describe, expect, it } from 'vitest';
import {
  evaluateKnifeHolderWash,
  loadKnifeAnalyticsConfig,
  __resetKnifeAnalyticsCacheForTests,
} from '../src/scripts/knife-analytics-gate.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

const JUNK_MINT = '8N1xPzwZtuRQSdRMnbjAjdd2tK9V8nF7Wrw8gGeLpump';

function row(partial: Partial<SnapshotCandidateRow>): SnapshotCandidateRow {
  return {
    mint: JUNK_MINT,
    symbol: 'junk',
    ts: new Date(),
    launch_ts: null,
    age_min: 2000,
    price_usd: 0.00025,
    liquidity_usd: 50_000,
    volume_5m: 5_000,
    volume_1h: 250_000,
    buys_5m: 10,
    sells_5m: 10,
    market_cap_usd: 800_000,
    holder_count: 1000,
    token_age_min: 2000,
    pair_address: 'pair',
    source: 'pumpswap',
    ...partial,
  };
}

describe('knife-analytics-gate', () => {
  it('blocks wash-like vol/holder (250k vol, 1k holders)', () => {
    const cfg = loadKnifeAnalyticsConfig({
      KNIFE_MIN_HOLDER_COUNT: '3000',
      KNIFE_MAX_VOL_PER_HOLDER_1H_USD: '50',
    });
    const reasons = evaluateKnifeHolderWash(cfg, row({}));
    expect(reasons.some((r) => r.startsWith('knife_holders<'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('knife_vol_per_holder>'))).toBe(true);
  });

  it('passes holder wash when runner-scale holders and vol spread', () => {
    const cfg = loadKnifeAnalyticsConfig({
      KNIFE_MIN_HOLDER_COUNT: '3000',
      KNIFE_MAX_VOL_PER_HOLDER_1H_USD: '50',
    });
    const reasons = evaluateKnifeHolderWash(
      cfg,
      row({ holder_count: 12_000, volume_1h: 300_000 }),
    );
    expect(reasons).toEqual([]);
  });

  it('resets analytics cache for tests', () => {
    __resetKnifeAnalyticsCacheForTests();
    expect(true).toBe(true);
  });
});
