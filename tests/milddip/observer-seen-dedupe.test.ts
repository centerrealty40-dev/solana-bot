import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.845 — the observer re-emitted the same transaction for the whole lookback
 * window, because `list(a_set)[-5000:]` keeps an arbitrary 5000 (sets have no
 * order) and dropped recent signatures at random.
 *
 * Measured 2026-08-12: **45 006 emitted legs from 924 distinct transactions**, one
 * signature re-emitted 348 times across 29.7 minutes at a 5.1s cadence — the poll
 * interval. 98% of the observer's reported USD volume was that echo, inflating
 * leader turnover roughly 48x and making every leader-volume figure unusable.
 */
describe('leader observer signature dedupe', () => {
  const py = readFileSync(resolve('scripts/milddip/leader-observer.py'), 'utf8');

  it('remembers signatures with their blockTime, not as a bare set', () => {
    expect(py).toContain('self.seen: dict[str, int] = {}');
    expect(py).toContain('self.seen[sig] = stamp');
  });

  it('prunes by age — a signature past the lookback can never return', () => {
    expect(py).toContain('horizon = max(int(self.lookback_sec) * 3, 7_200)');
    expect(py).toContain('kept = {sig: bt for sig, bt in self.seen.items() if bt >= floor_bt}');
  });

  it('no longer truncates by slicing an unordered set', () => {
    expect(py).not.toContain('list(self.seen)[-5000:]');
  });

  it('keeps a count cap as a backstop, applied newest-first', () => {
    expect(py).toContain('SEEN_SIGNATURE_CAP');
    expect(py).toContain('sorted(kept.items(), key=lambda kv: kv[1], reverse=True)');
  });

  it('persists the map and still loads the legacy list form', () => {
    expect(py).toContain('"seenSignatures": self.seen,');
    expect(py).toContain('if isinstance(sigs, dict):');
    expect(py).toContain('self.seen = {str(x): 0 for x in sigs if x}');
  });
});
