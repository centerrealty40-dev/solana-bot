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
    expect(loop).toContain('cfg.requireLeaderSeenFirstTouch && isFirstTouchForLeaderGate');
  });

  it('leaves the whole-funnel gate off, which starved entry in 1.11.816', () => {
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN: '0'");
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN_FIRST_TOUCH: '1'");
  });

  it('does not double-gate when the funnel-wide flag is on', () => {
    expect(loop).toContain('&& !cfg.requireLeaderSeen');
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
    expect(eco).toContain("MILD_DIP_MIN_TURNOVER_5M_LIQ: '0.03'");
    expect(eco).toContain("MILD_DIP_MIN_VOL5M_PACE_RATIO: '0.3'");
  });
});
