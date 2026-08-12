import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.846 — `getSignaturesForAddress` defaults to finalized, and finalized lags
 * badly on this provider.
 *
 * Measured 2026-08-12 against the same wallet in the same second:
 *
 * | commitment | newest signature | lag      |
 * |------------|------------------|----------|
 * | default    | 03:46:42         | 313 min  |
 * | finalized  | 03:46:42         | 313 min  |
 * | confirmed  | 08:59:47         | 0 min    |
 *
 * The transactions were reachable by `getTransaction` the whole time, so this was
 * purely the address index answering at the wrong commitment. Every leader-derived
 * signal — the seed, the leader-seen gate, the observer dataset — was reading a
 * five-hour-old view of the wallets we follow.
 */
describe('wallet signature polling commitment', () => {
  const ts = readFileSync(resolve('src/copytrader/rpc.ts'), 'utf8');
  const py = readFileSync(resolve('scripts/milddip/leader-observer.py'), 'utf8');

  it('copytrader polls at confirmed', () => {
    expect(ts).toContain("[wallet, { limit, commitment: 'confirmed' }]");
  });

  it('the leader observer polls at confirmed', () => {
    expect(py).toContain('"commitment": "confirmed"');
  });

  it('neither path relies on the default commitment', () => {
    expect(ts).not.toContain("'getSignaturesForAddress',\n    [wallet, { limit }],");
    expect(py).not.toContain('[leader, {"limit": self.sig_limit}]');
  });
});
