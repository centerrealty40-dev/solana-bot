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

describe('1.11.899 the first touch needs a leader to have been there', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('gates only the first position on a mint', () => {
    expect(loop).toContain('const isFirstTouchForLeaderGate = !state.lastExitByMint?.[mint]');
    expect(loop).toContain('cfg.requireLeaderSeenFirstTouch &&');
    expect(loop).toContain('isFirstTouchForLeaderGate &&');
  });

  it('leaves the whole-funnel gate off, which starved entry in 1.11.816', () => {
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN: '0'");
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN_FIRST_TOUCH: '1'");
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
    expect(src).toContain("const leaderSeenForAge = trigger === 'leader' || seedHit != null");
    expect(src).toContain('structuralOk(struct.metrics, cfg, leaderSeenForAge)');
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
    expect(loop).toContain('!leaderEverSeen(cfg, state, mint, nowMs)');
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

  it('no longer demands a cheaper re-entry than our last exit', () => {
    // Priced against our own first entry on the coin, re-entering above it is
    // four times better per position than re-entering below it, in all windows.
    expect(eco).toContain("MILD_DIP_REBUY_BELOW_EXIT_PCT: '0'");
  });
});

describe('1.11.914 a leader in the name overrides the structural priors', () => {
  const fast = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('drops the turnover ceiling for names a leader has traded', () => {
    // ELiQoVM9: 3.1h old, turnover 0.355, rejected 239 times on structural_fail
    // while the leader turned $149.57 into $249.73 on it in 23 minutes.
    expect(fast).toContain('const maxTurn = leaderSeen ? 0 : g.maxTurnover5mLiq;');
  });

  it('reads leader-seen from our memory, not just from the wake that found it', () => {
    expect(fast).toContain('|| leaderSeenMint');
    expect(loop).toContain('leaderEverSeen(cfg, state, mint, nowMs),');
  });
});

describe('1.11.909 the leader memory survives a restart', () => {
  it('is carried by the state loader, which drops anything it does not name', () => {
    const src = readFileSync(resolve('src/milddip/state.ts'), 'utf8');
    expect(src).toContain('leaderSeenMints:\n        parsed.leaderSeenMints');
    expect(src).toContain("leaderSeenMints: {},");
  });
});
