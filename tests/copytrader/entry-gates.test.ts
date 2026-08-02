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
    marketCapUsd: 900_000,
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
    };
    expect(evaluateLeaderMarketGate(off, null).pass).toBe(true);
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
