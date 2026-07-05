import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendDiscoveryHardMcapReasons,
  resolveDiscoveryRefMcap,
} from '../src/papertrader/filters/snapshot-filter.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function row(mcap: number | null): SnapshotCandidateRow {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'T',
    ts: new Date(),
    launch_ts: null,
    age_min: 3000,
    price_usd: 0.001,
    liquidity_usd: 200_000,
    volume_5m: 20_000,
    volume_1h: 50_000,
    buys_5m: 10,
    sells_5m: 5,
    market_cap_usd: mcap,
    pair_address: 'pair',
    source: 'pumpswap',
    holder_count: 1000,
    token_age_min: 3000,
  };
}

describe('discovery hard mcap floor', () => {
  const cfg = { discoveryMinMarketCapUsd: 2_000_000 } as PaperTraderConfig;

  it('rejects sub-$2M with pg source in reason', () => {
    const resolved = resolveDiscoveryRefMcap(row(800_000));
    const reasons: string[] = [];
    appendDiscoveryHardMcapReasons(cfg, resolved, reasons);
    expect(reasons).toEqual(['discovery_hard_mcap=800000<2000000_src=pg_snapshot']);
  });

  it('prefers shyft defi mcap when provided', () => {
    const resolved = resolveDiscoveryRefMcap(row(4_600_000), { defiMcapUsd: 780_000 });
    const reasons: string[] = [];
    appendDiscoveryHardMcapReasons(cfg, resolved, reasons);
    expect(resolved.source).toBe('shyft_defi');
    expect(reasons[0]).toContain('_src=shyft_defi');
  });

  it('uses shyft when pg mcap is zero', () => {
    const resolved = resolveDiscoveryRefMcap(row(0), { defiMcapUsd: 3_500_000 });
    expect(resolved).toEqual({
      refMcapUsd: 3_500_000,
      source: 'shyft_defi',
      pgMcapUsd: 0,
    });
    const reasons: string[] = [];
    appendDiscoveryHardMcapReasons(cfg, resolved, reasons);
    expect(reasons).toEqual([]);
  });

  it('uses evalRow mcap when pg snapshot mcap is null', () => {
    const pgRow = row(null);
    const evalRow = { ...pgRow, market_cap_usd: 2_800_000 };
    const resolved = resolveDiscoveryRefMcap(pgRow, { evalRow });
    expect(resolved.refMcapUsd).toBe(2_800_000);
    expect(resolved.source).toBe('price_scaled');
    expect(resolved.pgMcapUsd).toBe(0);
  });
});
