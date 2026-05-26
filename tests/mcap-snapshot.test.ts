import { describe, expect, it } from 'vitest';
import {
  impliedCirculatingSupplyTokens,
  pickBestSnapshotMcapRow,
  scaleMcapWithPrice,
  scoreSnapshotMcapRow,
} from '../src/papertrader/pricing/mcap-snapshot.js';

describe('mcap-snapshot', () => {
  it('prefers circulating (~900M supply) over FDV (~1B) rows', () => {
    const circulating = { priceUsd: 0.01818, marketCapUsd: 16_370_000 };
    const fdv = { priceUsd: 0.01808, marketCapUsd: 18_090_000 };
    expect(scoreSnapshotMcapRow(circulating, 900_000_000)).toBeGreaterThan(
      scoreSnapshotMcapRow(fdv, 900_000_000),
    );
    const best = pickBestSnapshotMcapRow([fdv, circulating], 900_000_000);
    expect(best?.marketCapUsd).toBe(16_370_000);
  });

  it('derives MANIFEST-like mcap from price × circulating supply', () => {
    const sup = impliedCirculatingSupplyTokens(16_370_000, 0.01818);
    expect(sup).not.toBeNull();
    expect(sup! / 1_000_000).toBeCloseTo(900, 0);
    const at0172 = 0.0172 * (sup as number);
    expect(at0172 / 1_000_000).toBeCloseTo(15.48, 1);
  });

  it('scales mcap when Jupiter refreshes price only', () => {
    const scaled = scaleMcapWithPrice(0.01864, 0.0172, 16_783_921);
    expect(scaled).not.toBeNull();
    expect(scaled! / 1_000_000).toBeCloseTo(15.48, 1);
  });
});
