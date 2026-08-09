import { describe, expect, it } from 'vitest';
import {
  ownTapeWakeMints,
  priorityMintsFromLastExit,
} from '../../src/milddip/discover.js';

const M1 = 'Cg1hswfyVfnFaKHSEVyNdFWEj1bmnZoA8ZnWLVbApump';
const M2 = '89gZQFtEe3RJctXghdbEmht8SV2vQvcN4DNyjmappump';
const M3 = '2qyejm9SjVF4pVTxT5rzRmnrWmeqscU7X7RkVHtQpump';
const HOT = 'HotMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('priorityMintsFromLastExit', () => {
  it('keeps exits inside the wake window and drops older', () => {
    const now = 1_000_000_000;
    const out = priorityMintsFromLastExit(
      {
        [M1]: { atMs: now - 3_600_000 }, // 1h ago
        [M2]: { atMs: now - 10 * 3_600_000 }, // 10h ago
        [M3]: { atMs: now - 60_000 },
      },
      now,
      { watchMs: 7_200_000, max: 48 },
    );
    expect(out[0]).toBe(M3);
    expect(out).toContain(M1);
    expect(out).not.toContain(M2);
  });
});

describe('ownTapeWakeMints', () => {
  it('pins post-exit before hot and never needs leader seeds', () => {
    const now = 2_000_000_000;
    const out = ownTapeWakeMints({
      hotMints: [HOT],
      lastExitByMint: {
        [M1]: { atMs: now - 3_600_000 },
      },
      cooldownUntilMs: {
        [M2]: now - 30 * 60_000, // cooled 30m ago
      },
      nowMs: now,
      postExitWakeMs: 7_200_000,
      postExitWakeMax: 48,
      maxTotal: 80,
    });
    expect(out.indexOf(M1)).toBeLessThan(out.indexOf(HOT));
    expect(out).toContain(M2);
    expect(out).toContain(HOT);
  });

  it('postExitWakeMs=0 → hot only', () => {
    const now = 3_000_000_000;
    const out = ownTapeWakeMints({
      hotMints: [HOT],
      lastExitByMint: { [M1]: { atMs: now - 1_000 } },
      cooldownUntilMs: { [M2]: now + 60_000 },
      nowMs: now,
      postExitWakeMs: 0,
      postExitWakeMax: 48,
    });
    expect(out).toEqual([HOT]);
  });
});
