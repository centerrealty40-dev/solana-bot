import { describe, expect, it } from 'vitest';
import {
  evaluateLeaderCopyGates,
  evaluateLeaderMarketGate,
  evaluateLeaderPriorGate,
  type LeaderGateConfig,
} from '../../src/copytrader/entry-gates.js';
import type { CopyEntryContext } from '../../src/copytrader/entry-context.js';
import type { LeaderMintStats } from '../../src/copytrader/leader-history.js';

const cfg: LeaderGateConfig = {
  leaderGatesEnabled: true,
  minLeaderPriorSessions: 3,
  minLeaderPriorAvgPct: 5,
  entryMinPairAgeHours: 1,
  entryMaxPairAgeHours: 72,
  entryMinBuySellRatio5m: 1.05,
  entryMaxChase5mPct: 15,
  entryMinTurnover5m: 0,
  entryMinVolToMcap1h: 0,
  entryMinVolume5mUsd: 0,
  entryVol5mAdjacentWindows: 3,
  leaderFollowOnlyMinMcapUsd: 0,
  leaderFollowOnlyMinVolume1hUsd: 0,
};

/** What copy-trader-8zkg actually runs: market structure, no mint memory. */
const shipped: LeaderGateConfig = {
  leaderGatesEnabled: true,
  minLeaderPriorSessions: 0,
  minLeaderPriorAvgPct: -100,
  entryMinPairAgeHours: 1,
  entryMaxPairAgeHours: 30,
  entryMinBuySellRatio5m: 0,
  entryMaxChase5mPct: 0,
  entryMinTurnover5m: 0.09,
  entryMinVolToMcap1h: 0.33,
  entryMinVolume5mUsd: 0,
  entryVol5mAdjacentWindows: 3,
  leaderFollowOnlyMinMcapUsd: 0,
  leaderFollowOnlyMinVolume1hUsd: 0,
};

const goodStats: LeaderMintStats = {
  sessions: 9,
  avgPct: 12,
  winRatePct: 61,
  lastClosedTs: 1,
};

function ctx(over: Partial<CopyEntryContext> = {}): CopyEntryContext {
  return {
    mint: 'Mint111',
    pairAgeHours: 10,
    buys5m: 120,
    sells5m: 90,
    buySellRatio5m: 120 / 90,
    priceChange5mPct: -2,
    liquidityUsd: 40_000,
    marketCapUsd: 200_000,
    volume5mUsd: 8_000,
    volume1hUsd: 90_000,
    fetchedAtMs: 1,
    ...over,
  };
}

describe('leader prior-record gate', () => {
  it('passes a mint the leader trades well', () => {
    expect(evaluateLeaderPriorGate(cfg, goodStats).pass).toBe(true);
  });

  it('rejects a mint with no history — the cold-start case', () => {
    const res = evaluateLeaderPriorGate(cfg, null);
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('leader_prior_sessions=0');
  });

  it('rejects too few sessions even when they were profitable', () => {
    const res = evaluateLeaderPriorGate(cfg, { ...goodStats, sessions: 2 });
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('<min=3');
  });

  it('rejects a mint the leader loses on', () => {
    const res = evaluateLeaderPriorGate(cfg, { ...goodStats, avgPct: 1.2 });
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('leader_prior_avg_pct=1.2');
  });

  it('is inert when gates are disabled', () => {
    expect(evaluateLeaderPriorGate({ ...cfg, leaderGatesEnabled: false }, null).pass).toBe(true);
  });
});

describe('leader market-context gate', () => {
  it('passes a young pair with mild buyer pressure', () => {
    expect(evaluateLeaderMarketGate(cfg, ctx()).pass).toBe(true);
  });

  it('rejects a brand-new pair', () => {
    const res = evaluateLeaderMarketGate(cfg, ctx({ pairAgeHours: 0.2 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('pair_age_h=0.2<min=1');
  });

  it('rejects a stale pair past the edge window', () => {
    const res = evaluateLeaderMarketGate(cfg, ctx({ pairAgeHours: 200 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('>max=72');
  });

  it('rejects sell-heavy tape', () => {
    const res = evaluateLeaderMarketGate(cfg, ctx({ buys5m: 40, sells5m: 90, buySellRatio5m: 40 / 90 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('buy_sell_5m=0.44');
  });

  it('rejects chasing a 5m spike', () => {
    const res = evaluateLeaderMarketGate(cfg, ctx({ priceChange5mPct: 42 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('chase_5m_pct=42.0');
  });

  it('allows buying into a dip', () => {
    expect(evaluateLeaderMarketGate(cfg, ctx({ priceChange5mPct: -9 })).pass).toBe(true);
  });

  it('fails closed when context is missing', () => {
    const res = evaluateLeaderMarketGate(cfg, null);
    expect(res.pass).toBe(false);
    expect(res.reasons).toEqual(['no_entry_context']);
  });

  it('fails closed on individually unknown fields', () => {
    const res = evaluateLeaderMarketGate(
      cfg,
      ctx({ pairAgeHours: null, buySellRatio5m: null, priceChange5mPct: null }),
    );
    expect(res.reasons).toEqual(['pair_age_unknown', 'buy_sell_ratio_unknown', 'price_change_5m_unknown']);
  });

  it('does not need context when every market threshold is off', () => {
    const off: LeaderGateConfig = {
      ...cfg,
      entryMinPairAgeHours: 0,
      entryMaxPairAgeHours: 0,
      entryMinBuySellRatio5m: 0,
      entryMaxChase5mPct: 0,
      entryMinTurnover5m: 0,
      entryMinVolToMcap1h: 0,
      entryMinVolume5mUsd: 0,
    };
    expect(evaluateLeaderMarketGate(off, null).pass).toBe(true);
  });

  it('rejects thin 5m volume when absolute floor is set', () => {
    const volOnly: LeaderGateConfig = {
      ...cfg,
      entryMinPairAgeHours: 0,
      entryMaxPairAgeHours: 0,
      entryMinBuySellRatio5m: 0,
      entryMaxChase5mPct: 0,
      entryMinVolume5mUsd: 8000,
      entryVol5mAdjacentWindows: 0,
    };
    const res = evaluateLeaderMarketGate(volOnly, ctx({ volume5mUsd: 2500 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('volume_5m_usd=2500<min=8000');
  });

  it('passes quiet m5 when 1h volume covers adjacent 5m windows', () => {
    const volOnly: LeaderGateConfig = {
      ...cfg,
      entryMinPairAgeHours: 0,
      entryMaxPairAgeHours: 0,
      entryMinBuySellRatio5m: 0,
      entryMaxChase5mPct: 0,
      entryMinVolume5mUsd: 8000,
      entryVol5mAdjacentWindows: 3,
    };
    // F6Tbmw-class: lull in current m5, but ~$115k/h sustained.
    const res = evaluateLeaderMarketGate(
      volOnly,
      ctx({ volume5mUsd: 2948, volume1hUsd: 114_829, marketCapUsd: 421_313 }),
    );
    expect(res.pass).toBe(true);
  });

  it('still rejects when both m5 and 1h-adjacent cover fail', () => {
    const volOnly: LeaderGateConfig = {
      ...cfg,
      entryMinPairAgeHours: 0,
      entryMaxPairAgeHours: 0,
      entryMinBuySellRatio5m: 0,
      entryMaxChase5mPct: 0,
      entryMinVolume5mUsd: 8000,
      entryVol5mAdjacentWindows: 3,
    };
    const res = evaluateLeaderMarketGate(volOnly, ctx({ volume5mUsd: 2500, volume1hUsd: 10_000 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('volume_5m_usd=2500<min=8000');
    expect(res.reasons[0]).toContain('volume_1h_usd=10000<min=24000(3x5m)');
  });

  it('fails closed when volume floor is on but feed is missing', () => {
    const volOnly: LeaderGateConfig = {
      ...cfg,
      entryMinPairAgeHours: 0,
      entryMaxPairAgeHours: 0,
      entryMinBuySellRatio5m: 0,
      entryMaxChase5mPct: 0,
      entryMinVolume5mUsd: 8000,
    };
    const res = evaluateLeaderMarketGate(volOnly, ctx({ volume5mUsd: null }));
    expect(res.pass).toBe(false);
    expect(res.reasons).toEqual(['volume_5m_unknown']);
  });
});

describe('turnover gates', () => {
  it('passes a pool that is actually being traded', () => {
    expect(evaluateLeaderMarketGate(shipped, ctx()).pass).toBe(true);
  });

  it('rejects a pool with liquidity but no 5m flow', () => {
    const res = evaluateLeaderMarketGate(shipped, ctx({ volume5mUsd: 900, liquidityUsd: 40_000 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('turnover_5m=0.022<min=0.09');
  });

  it('accepts a thin pool as long as the flow is large against it', () => {
    const res = evaluateLeaderMarketGate(shipped, ctx({ liquidityUsd: 6_000, volume5mUsd: 2_000, marketCapUsd: 40_000 }));
    expect(res.pass).toBe(true);
  });

  it('rejects a large cap that barely trades', () => {
    const res = evaluateLeaderMarketGate(shipped, ctx({ marketCapUsd: 9_000_000, volume1hUsd: 90_000 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('vol_to_mcap_1h=0.010<min=0.33');
  });

  it('treats an unreadable feed as unknown rather than zero turnover', () => {
    const res = evaluateLeaderMarketGate(shipped, ctx({ liquidityUsd: 0, marketCapUsd: null }));
    expect(res.pass).toBe(false);
    expect(res.reasons).toEqual(['turnover_5m_unknown', 'vol_to_mcap_1h_unknown']);
  });

  it('ignores the leader mint history the shipped config switched off', () => {
    expect(evaluateLeaderCopyGates(shipped, { stats: null, ctx: ctx() }).pass).toBe(true);
    expect(
      evaluateLeaderCopyGates(shipped, { stats: { sessions: 1, avgPct: -40, winRatePct: 0, lastClosedTs: 1 }, ctx: ctx() })
        .pass,
    ).toBe(true);
  });

  it('still rejects a pair past the 30h window', () => {
    const res = evaluateLeaderMarketGate(shipped, ctx({ pairAgeHours: 44 }));
    expect(res.pass).toBe(false);
    expect(res.reasons[0]).toContain('>max=30');
  });

  it('bypasses vol5m floor on large liquid names (mcap+$1M, vol1h $50k)', () => {
    const mirrorLane: LeaderGateConfig = {
      ...shipped,
      entryMinTurnover5m: 0,
      entryMinVolToMcap1h: 0,
      entryMaxPairAgeHours: 0,
      entryMinPairAgeHours: 0.1,
      entryMinVolume5mUsd: 8_000,
      entryVol5mAdjacentWindows: 0,
      leaderFollowOnlyMinMcapUsd: 1_000_000,
      leaderFollowOnlyMinVolume1hUsd: 50_000,
    };
    const lowVol5m = ctx({
      volume5mUsd: 3_590,
      marketCapUsd: 2_000_000,
      volume1hUsd: 120_000,
    });
    expect(evaluateLeaderMarketGate(mirrorLane, lowVol5m).pass).toBe(true);

    const notLarge = ctx({
      volume5mUsd: 3_590,
      marketCapUsd: 400_000,
      volume1hUsd: 120_000,
    });
    expect(evaluateLeaderMarketGate(mirrorLane, notLarge).pass).toBe(false);
    expect(evaluateLeaderMarketGate(mirrorLane, notLarge).reasons[0]).toContain('volume_5m_usd=');
  });
});

describe('combined gate', () => {
  it('reports every failing reason at once', () => {
    const res = evaluateLeaderCopyGates(cfg, {
      stats: null,
      ctx: ctx({ pairAgeHours: 0.1, priceChange5mPct: 80 }),
    });
    expect(res.pass).toBe(false);
    expect(res.reasons).toHaveLength(3);
  });

  it('passes the configuration the audit selected', () => {
    expect(evaluateLeaderCopyGates(cfg, { stats: goodStats, ctx: ctx() }).pass).toBe(true);
  });
});
