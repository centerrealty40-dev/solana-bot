import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLeaderSeedHits,
  parseLeaderSeedMints,
  resetDiscoverExtraCachesForTests,
  upsertLeaderSeedMint,
} from '../../src/milddip/discover-extra.js';

const M1 = 'Cg1hswfyVfnFaKHSEVyNdFWEj1bmnZoA8ZnWLVbApump';
const M2 = '89gZQFtEe3RJctXghdbEmht8SV2vQvcN4DNyjmappump';
const M3 = '2qyejm9SjVF4pVTxT5rzRmnrWmeqscU7X7RkVHtQpump';

describe('leader seed sidecar', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    resetDiscoverExtraCachesForTests();
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('filters by age and caps count', () => {
    const now = 10_000_000;
    const out = parseLeaderSeedMints(
      {
        hits: [
          { mint: M1, lastSeenAtMs: now - 1_000 },
          { mint: M2, lastSeenAtMs: now - 3_600_000 },
          { mint: M3, lastSeenAtMs: now - 10_000_000 },
        ],
      },
      now,
      { maxAgeMs: 2 * 3_600_000, max: 1 },
    );
    expect(out).toEqual([M1]);
  });

  it('upserts atomically and refreshes lastSeen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-seed-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'leader-seed.json');
    upsertLeaderSeedMint(
      file,
      { mint: M1, lastSeenAtMs: 1000, leader: 'L1', signature: 's1' },
      { nowMs: 1000, max: 40, maxAgeMs: 7_200_000 },
    );
    upsertLeaderSeedMint(
      file,
      { mint: M1, lastSeenAtMs: 2000, leader: 'L1', signature: 's2' },
      { nowMs: 2000, max: 40, maxAgeMs: 7_200_000 },
    );
    upsertLeaderSeedMint(
      file,
      { mint: M2, lastSeenAtMs: 1500, leader: 'L1', signature: 's3' },
      { nowMs: 2000, max: 40, maxAgeMs: 7_200_000 },
    );
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hits: Array<{ mint: string; lastSeenAtMs: number; signature?: string }>;
    };
    expect(raw.hits).toHaveLength(2);
    expect(raw.hits[0]!.mint).toBe(M1);
    expect(raw.hits[0]!.lastSeenAtMs).toBe(2000);
    expect(raw.hits[0]!.signature).toBe('s2');
    expect(parseLeaderSeedMints(raw, 2500, { maxAgeMs: 7_200_000, max: 40 })).toEqual([
      M1,
      M2,
    ]);
  });

  it('keeps both leaders when they buy one mint together', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-seed-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'leader-seed.json');
    upsertLeaderSeedMint(
      file,
      { mint: M1, lastSeenAtMs: 1000, leader: 'L1', signature: 's1', fillPriceUsd: 1 },
      { nowMs: 1000, max: 40, maxAgeMs: 7_200_000 },
    );
    upsertLeaderSeedMint(
      file,
      { mint: M1, lastSeenAtMs: 1100, leader: 'L2', signature: 's2', fillPriceUsd: 2 },
      { nowMs: 1100, max: 40, maxAgeMs: 7_200_000 },
    );
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hits: Array<{
        mint: string;
        leader?: string;
        signature?: string;
        fillPriceUsd?: number;
      }>;
    };
    expect(raw.hits).toHaveLength(2);
    expect(
      raw.hits.map((h) => [h.leader, h.signature, h.fillPriceUsd]),
    ).toEqual([
      ['L2', 's2', 2],
      ['L1', 's1', 1],
    ]);
    expect(
      parseLeaderSeedHits(raw, 1200, {
        maxAgeMs: 7_200_000,
        max: 40,
        dedupeBy: 'mint_leader',
      }).map((h) => h.leader),
    ).toEqual(['L2', 'L1']);
    expect(
      parseLeaderSeedMints(raw, 1200, { maxAgeMs: 7_200_000, max: 40 }),
    ).toEqual([M1]);
  });
});
