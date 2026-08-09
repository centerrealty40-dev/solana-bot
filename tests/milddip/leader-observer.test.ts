/**
 * Smoke-import check: leader-observer is Python; gate band docs stay in sync
 * with discover/live via the divergence script comments. This file pins the
 * env contract so CI notices if ecosystem drops absolute logging.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mild-dip leader-observer contract (1.11.780)', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const py = readFileSync(resolve('scripts/milddip/leader-observer.py'), 'utf8');

  it('ecosystem enables dense absolute sell + mark logging for both leaders', () => {
    expect(eco).toContain("LEADER_OBSERVER_LOG_SELLS: '1'");
    expect(eco).toContain("LEADER_OBSERVER_LOG_MARKS: '1'");
    expect(eco).toContain("LEADER_OBSERVER_POLL_SEC: '5'");
    expect(eco).toContain("LEADER_OBSERVER_MARK_MIN_GAP_SEC: '15'");
    expect(eco).toContain("LEADER_OBSERVER_SIG_LIMIT: '100'");
    expect(eco).toContain('mild-dip-leader-observer');
    expect(eco).toContain('8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ');
    expect(eco).toContain('7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5');
  });

  it('python observer emits sell + session + mark + Dex-path exit fields', () => {
    expect(py).toContain('leader_sell_observed');
    expect(py).toContain('leader_session_open');
    expect(py).toContain('leader_session_flat');
    expect(py).toContain('leader_bag_mark');
    expect(py).toContain('fillPriceUsd');
    expect(py).toContain('sizeUsd');
    expect(py).toContain('turn_dump_snapshot');
    expect(py).toContain('mfePct');
    expect(py).toContain('givebackPct');
    expect(py).toContain('bounceFromTroughPct');
    expect(py).toContain('entryDexPriceUsd');
    expect(py).toContain('pnlDexPct');
    expect(py).toContain('dex_rebase_first_mark');
    expect(py).toContain('"version": "1.11.780"');
    expect(py).toContain('-25 < pc_f <= -2');
  });

  it('ships 48h divergence + segment stats scripts', () => {
    const report = readFileSync(
      resolve('scripts/milddip/leader-divergence-48h.py'),
      'utf8',
    );
    expect(report).toContain('WE_SOLD_LEADER_BOUGHT_AFTER');
    expect(report).toContain('LEADER_SOLD_BEFORE_OUR_EXIT');
    const seg = readFileSync(resolve('scripts/milddip/leader-segment-stats.py'), 'utf8');
    expect(seg).toContain('entryClass');
    expect(seg).toContain('turnDump');
  });
});
