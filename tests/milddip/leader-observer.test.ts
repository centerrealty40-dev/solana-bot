/**
 * Smoke-import check: leader-observer is Python; gate band docs stay in sync
 * with discover/live via the divergence script comments. This file pins the
 * env contract so CI notices if ecosystem drops sell logging.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mild-dip leader-observer contract (1.11.760)', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const py = readFileSync(resolve('scripts/milddip/leader-observer.py'), 'utf8');

  it('ecosystem enables sell logging', () => {
    expect(eco).toContain("LEADER_OBSERVER_LOG_SELLS: '1'");
    expect(eco).toContain('mild-dip-leader-observer');
  });

  it('python observer emits sell + session events', () => {
    expect(py).toContain('leader_sell_observed');
    expect(py).toContain('leader_session_open');
    expect(py).toContain('leader_session_flat');
    expect(py).toContain('fillPriceUsd');
    expect(py).toContain('sizeUsd');
    expect(py).toContain('-25 < pc_f <= -8');
  });

  it('ships 48h divergence report script', () => {
    const report = readFileSync(
      resolve('scripts/milddip/leader-divergence-48h.py'),
      'utf8',
    );
    expect(report).toContain('WE_SOLD_LEADER_BOUGHT_AFTER');
    expect(report).toContain('LEADER_SOLD_BEFORE_OUR_EXIT');
  });
});
