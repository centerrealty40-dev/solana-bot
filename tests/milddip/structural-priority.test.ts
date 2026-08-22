import { describe, expect, it } from 'vitest';
import { prioritizeFreshStructuralEntries } from '../../src/milddip/structural-priority.js';

describe('mirror structural backfill priority', () => {
  it('puts fresh observations ahead of older observations within the batch cap', () => {
    const entries = [
      { id: 'oldest', startedAtMs: 1_000 },
      { id: 'old', startedAtMs: 2_000 },
      { id: 'fresh', startedAtMs: 99_000 },
    ];

    expect(prioritizeFreshStructuralEntries(entries, 100_000, 60_000, 2, (entry) => entry.startedAtMs)).toEqual([
      { id: 'fresh', startedAtMs: 99_000 },
      { id: 'oldest', startedAtMs: 1_000 },
    ]);
  });
});
