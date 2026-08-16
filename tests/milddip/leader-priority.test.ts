import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('1.11.824 leader seeds order the scan queue', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const discover = readFileSync(resolve('src/milddip/discover.ts'), 'utf8');

  it('leaders is an enabled discovery source', () => {
    expect(eco).toContain("MILD_DIP_DISCOVER_SOURCES: 'stream,boosts,profiles,leaders'");
  });

  it('the enrich budget is sized to what the API answers, not to the RPM ceiling', () => {
    // 1.11.863 took this to 60 on headroom arithmetic. Five hours of live data
    // said otherwise: null responses went 1.6% -> 35.5% and the revisit gap
    // got worse, 82.0s -> 94.1s, because the extra slots pulled in tail mints
    // DexScreener has no data for. The 3s cadence is the part that mattered.
    expect(eco).toContain("MILD_DIP_ENRICH_MAX: '20'");
    expect(eco).toContain("DEXSCREENER_GLOBAL_MAX_RPM: '120'");
    // And the scan no longer drops to a 15s cadence the moment a bag is open.
    expect(eco).toContain("MILD_DIP_SCAN_INTERVAL_WITH_OPENS_MS: '3000'");
  });

  it('seeds are pushed ahead of the generic sources', () => {
    const priorityAt = discover.indexOf('opts?.priorityMints ?? []');
    const leadersAt = discover.indexOf("sources.has('leaders')");
    const streamAt = discover.indexOf("sources.has('stream')");
    expect(priorityAt).toBeGreaterThan(-1);
    expect(leadersAt).toBeGreaterThan(priorityAt);
    if (streamAt > -1) expect(leadersAt).toBeLessThan(streamAt);
  });

  it('seed window and cap are the ones the gate was sized for', () => {
    expect(eco).toContain("MILD_DIP_LEADER_SEED_MAX: '250'");
    expect(eco).toContain("MILD_DIP_LEADER_SEED_MAX_AGE_MS: '7200000'");
  });
});

describe('1.11.899 / 1.11.922 first touch vs compete-first', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('gates only the first position on a mint when first-touch flag is on', () => {
    expect(loop).toContain('const isFirstTouchForLeaderGate = !state.lastExitByMint?.[mint]');
    expect(loop).toContain('cfg.requireLeaderSeenFirstTouch &&');
    expect(loop).toContain('isFirstTouchForLeaderGate &&');
  });

  it('first-touch leader gate off — compete on stream before leader buy', () => {
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN: '1'");
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN_FIRST_TOUCH: '0'");
  });

  it('does not double-gate when the funnel-wide flag is on', () => {
    expect(loop).toContain('!cfg.requireLeaderSeen &&');
  });
});

describe('1.11.905 a name a leader is buying may be younger', () => {
  const src = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('lowers the age floor and never raises it', () => {
    expect(src).toContain('Math.min(g.minPairAgeHoursLeaderSeen, g.minPairAgeHours)');
    expect(src).toContain('metrics.pairAgeHours < minAge');
  });

  it('counts a leader trigger or a seed hit as evidence', () => {
    expect(src).toContain('trigger === \'leader\' || seedHit != null || leaderSeenAtMs != null');
    expect(src).toContain('hotDeepKnifeOk,');
    expect(src).toContain('leaderFreshBuy,');
  });

  it('live env allows one hour there and six everywhere else', () => {
    // 4CmYEyg: the leaders traded it 26 times while it sat behind our floor.
    expect(eco).toContain("MILD_DIP_MIN_PAIR_AGE_HOURS_LEADER_SEEN: '1'");
    expect(eco).toContain("MILD_DIP_MIN_PAIR_AGE_HOURS: '6'");
  });

  it('every other floor still applies to a young name', () => {
    expect(eco).toContain("MILD_DIP_MIN_LIQUIDITY_USD: '8000'");
    expect(eco).toContain("MILD_DIP_MIN_TURNOVER_5M_LIQ: '0.06'");
    expect(eco).toContain("MILD_DIP_MIN_VOL5M_PACE_RATIO: '0.3'");
  });
});

describe('1.11.906 the gate remembers a leader for a week, not two hours', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('accumulates every seed read into a durable memory', () => {
    // The seed file is a two-hour view by design, so reading it alone made the
    // gate stricter than the measurement it came from, which asked "ever".
    expect(loop).toContain('function rememberLeaderSeen(');
    expect(loop).toContain('mem[h.mint] = Math.max(mem[h.mint] ?? 0, h.lastSeenAtMs || nowMs)');
    expect(loop).toContain('if (nowMs - ts > cfg.leaderSeenMemoryMs) delete mem[mint]');
  });

  it('consults the memory before rejecting a first touch', () => {
    expect(loop).toContain('leaderEverSeenInState');
  });

  it('live env remembers for a week', () => {
    expect(eco).toContain("MILD_DIP_LEADER_SEEN_MEMORY_MS: '604800000'");
  });
});

describe('1.11.907/908 turnover ceiling and the re-entry price rule', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const gates = readFileSync(resolve('src/milddip/gates.ts'), 'utf8');
  const fast = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');

  it('caps turnover as well as flooring it, on both gate paths', () => {
    expect(eco).toContain("MILD_DIP_MAX_TURNOVER_5M_LIQ: '0.25'");
    expect(gates).toContain('turn > gates.maxTurnover5mLiq');
    expect(fast).toContain('maxTurn > 0 && turn > maxTurn');
  });

  it('requires a materially cheaper re-entry than our last exit', () => {
    // Avoid selling and rebuying the same reclaim candle; the production floor
    // requires the next entry to be at least 5% below our exit fill.
    expect(eco).toContain("MILD_DIP_REBUY_BELOW_EXIT_PCT: '5'");
  });
});

describe('1.11.914 a leader in the name overrides the structural priors', () => {
  const fast = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('drops turnover ceiling on fresh leader co-buy or hot deep dump signal', () => {
    expect(fast).toContain('const relaxTurnVol = leaderFreshBuy || hotDeepDump;');
    expect(fast).toContain('const maxTurn = relaxTurnVol ? 0 : g.maxTurnover5mLiq;');
  });

  it('reads leader-seen timestamp from state memory', () => {
    expect(fast).toContain('leaderSeenAtMs?: number | null');
    expect(loop).toContain('state.leaderSeenMints?.[mint] ?? null');
  });
});

describe('1.11.909 the leader memory survives a restart', () => {
  it('is carried by the state loader, which drops anything it does not name', () => {
    const src = readFileSync(resolve('src/milddip/state.ts'), 'utf8');
    expect(src).toContain('leaderSeenMints:\n        parsed.leaderSeenMints');
    expect(src).toContain("leaderSeenMints: {},");
  });
});

describe('1.11.915 the leader override covers every fitted prior', () => {
  const fast = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('drops the 5m volume ceiling and the turnover floor only on fresh co-buy', () => {
    expect(fast).toContain('const maxVol = relaxTurnVol ? 0 : g.maxVolume5mUsd;');
    expect(fast).toContain('const minTurn = relaxTurnVol ? 0 : g.minTurnover5mLiq;');
  });

  it('lets the dip ceiling out to flat, but no further', () => {
    expect(fast).toContain(
      'const maxDip = leaderSeenName ? Math.max(cfg.entry.maxDipPct, 0) : cfg.entry.maxDipPct;',
    );
    expect(fast).toContain('inDipBand(dexPc, cfg.entry.minDipPct, maxDip)');
    expect(fast).toContain('maxDipPct: maxDip,');
  });

  it('stops deferring deep knife when hot dump OR qualifies on stream', () => {
    expect(fast).toContain('!knifeOrOk\n  ) {');
    expect(fast).toContain('const hotDeepKnife = turnDumpKnifeOrOk({');
  });

  it('re-checks wait-dip floors with the same knowledge as the entry gate', () => {
    expect(loop).toContain('leaderFreshBuy');
    expect(loop).toContain('mild_dip_leader_co_buy_skip');
  });
});

describe('1.11.922 hot deep dump — stream signal, not leader follow', () => {
  const fast = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('evaluates hot knife OR before structural turnover choke', () => {
    expect(fast).toContain('const hotDeepKnife = turnDumpKnifeOrOk({');
    expect(fast).toContain('hotDeepKnifeOk,');
    expect(fast).toContain('knifeBranchEnabled: true,');
  });

  it('does not defer deep knife when hot deep dump qualifies', () => {
    expect(fast).toContain('!knifeOrOk\n  ) {');
    expect(fast).not.toContain('!leaderSeenName\n  ) {');
  });

  it('first touch does not require leader seen (compete first)', () => {
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN_FIRST_TOUCH: '0'");
  });
});

describe('1.11.921 leader co-buy align blocks low-turn solo dips', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const fast = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');

  it('is enabled in live config with the 48h analysis window', () => {
    expect(eco).toContain("MILD_DIP_LEADER_CO_BUY_ALIGN: '1'");
    expect(eco).toContain("MILD_DIP_LEADER_CO_BUY_ALIGN_MAX_MS: '120000'");
    expect(eco).toContain("MILD_DIP_LEADER_CO_BUY_ALIGN_MIN_TURN: '0.06'");
  });

  it('skips fast-path when turn is below floor and leader is not fresh', () => {
    expect(fast).toContain("return skip('leader_co_buy_align'");
    expect(fast).toContain('export function leaderCoBuyAlignOk');
  });
});
