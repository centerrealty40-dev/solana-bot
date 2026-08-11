import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  leaderSeedHitByMint,
  parseLeaderSeedHits,
  type LeaderSeedHit,
} from '../../src/milddip/discover-extra.js';

const NOW = 1_786_000_000_000;

function hit(mint: string, ageMin: number): LeaderSeedHit {
  return { mint, lastSeenAtMs: NOW - ageMin * 60_000, leader: '8zkg' };
}

describe('1.11.816 leader-seen entry gate', () => {
  it('keeps prints inside the window and drops stale ones', () => {
    const hits = parseLeaderSeedHits(
      {
        hits: [
          hit('A'.repeat(40), 5),
          hit('B'.repeat(40), 119),
          hit('C'.repeat(40), 200),
        ],
      },
      NOW,
      { maxAgeMs: 7_200_000, max: 250 },
    );
    const mints = hits.map((h) => h.mint[0]);
    expect(mints).toContain('A');
    expect(mints).toContain('B');
    expect(mints).not.toContain('C');
  });

  it('lookup answers the gate question per mint', () => {
    const hits = parseLeaderSeedHits({ hits: [hit('A'.repeat(40), 29)] }, NOW, {
      maxAgeMs: 7_200_000,
      max: 250,
    });
    expect(leaderSeedHitByMint(hits, 'A'.repeat(40))).not.toBeNull();
    expect(leaderSeedHitByMint(hits, 'Z'.repeat(40))).toBeNull();
  });

  it('seed capacity holds a 2h window of leader flow', () => {
    // Leaders open ~36 bags/h; 40 slots evicted names mid-qualification.
    const many = Array.from({ length: 120 }, (_, i) =>
      hit(String.fromCharCode(65 + (i % 26)).repeat(39) + String(i % 10), i),
    );
    expect(parseLeaderSeedHits({ hits: many }, NOW, { maxAgeMs: 7_200_000, max: 40 }).length).toBe(40);
    expect(
      parseLeaderSeedHits({ hits: many }, NOW, { maxAgeMs: 7_200_000, max: 250 }).length,
    ).toBeGreaterThan(40);
  });

  it('live env turns the gate on with matching seed caps', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN: '1'");
    expect(eco).toContain("MILD_DIP_LEADER_SEED_MAX: '250'");
    expect(eco).toContain("LEADER_OBSERVER_SEED_MAX: '250'");
  });

  it('gate runs before the Dex round-trip and journals its skips', () => {
    const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(loop).toContain('mild_dip_not_leader_seen_skip');
    expect(loop).toContain('cfg.requireLeaderSeen');
  });
});
