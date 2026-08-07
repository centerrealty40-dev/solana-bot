import { describe, expect, it } from 'vitest';
import { priorityMintsFromRecentTrades } from '../../src/milddip/discover.js';

const M1 = 'Cg1hswfyVfnFaKHSEVyNdFWEj1bmnZoA8ZnWLVbApump';
const M2 = '89gZQFtEe3RJctXghdbEmht8SV2vQvcN4DNyjmappump';
const M3 = '2qyejm9SjVF4pVTxT5rzRmnrWmeqscU7X7RkVHtQpump';

describe('priorityMintsFromRecentTrades', () => {
  it('keeps mints whose cooldown ended within the watch window', () => {
    const now = 1_000_000_000;
    const out = priorityMintsFromRecentTrades(
      {
        [M1]: now - 3_600_000, // ended 1h ago
        [M2]: now - 10 * 3_600_000, // ended 10h ago — outside 6h watch
        [M3]: now + 120_000, // still cooling
      },
      now,
      { watchMs: 6 * 3_600_000, max: 40 },
    );
    expect(out).toContain(M1);
    expect(out).toContain(M3);
    expect(out).not.toContain(M2);
  });
});
