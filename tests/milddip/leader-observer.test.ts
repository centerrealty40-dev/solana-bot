/**
 * Smoke-import check: leader-observer is Python; gate band docs stay in sync
 * with discover/live via the divergence script comments. This file pins the
 * env contract so CI notices if ecosystem drops absolute logging.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mild-dip leader-observer contract (1.11.790)', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const py = readFileSync(resolve('scripts/milddip/leader-observer.py'), 'utf8');

  it('ecosystem enables absolute sell + mark logging for both leaders', () => {
    expect(eco).toContain("LEADER_OBSERVER_LOG_SELLS: '1'");
    expect(eco).toContain("LEADER_OBSERVER_LOG_MARKS: '1'");
    expect(eco).toContain('mild-dip-leader-observer');
    expect(eco).toContain('8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ');
    expect(eco).toContain('7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5');
  });

  it('ecosystem enables 1Hz dense exit tape (1.11.790)', () => {
    expect(eco).toContain("LEADER_OBSERVER_DENSE_TICKS: '1'");
    expect(eco).toContain("LEADER_OBSERVER_DENSE_GAP_SEC: '1'");
    expect(eco).toContain("LEADER_OBSERVER_DEX_REFRESH_SEC: '15'");
    expect(eco).toContain("LEADER_OBSERVER_MARK_MIN_GAP_SEC: '15'");
    expect(eco).toContain("LEADER_OBSERVER_POLL_SEC: '5'");
    expect(eco).toContain('api.jup.ag/price/v3');
  });

  it('python observer emits sell + session + mark + turnDump events', () => {
    expect(py).toContain('leader_sell_observed');
    expect(py).toContain('leader_session_open');
    expect(py).toContain('leader_session_flat');
    expect(py).toContain('leader_bag_mark');
    expect(py).toContain('fillPriceUsd');
    expect(py).toContain('sizeUsd');
    expect(py).toContain('turn_dump_snapshot');
    expect(py).toContain('mfePct');
    expect(py).toContain('-25 < pc_f <= -2');
  });

  it('python observer emits dense ticks with exit-formula fields (1.11.790)', () => {
    expect(py).toContain('leader_bag_tick');
    expect(py).toContain('leader-dense-');
    expect(py).toContain('emit_dense_ticks');
    expect(py).toContain('givebackPct');
    expect(py).toContain('bouncePct');
    expect(py).toContain('armedMfe5');
    expect(py).toContain('durNeg12');
    expect(py).toContain('fetch_jupiter_prices');
    expect(py).toContain('apply_path_metrics');
  });

  it('dual-writes cash trade_fill/roundtrip into shared trades.jsonl (1.11.786)', () => {
    expect(eco).toContain('LEADER_OBSERVER_TRADES_PATH');
    expect(eco).toContain('MILD_DIP_TRADES_PATH');
    expect(eco).toContain('trades.jsonl');
    expect(py).toContain('emit_trade');
    expect(py).toContain('trade_fill');
    expect(py).toContain('trade_roundtrip');
    expect(py).toContain('totalCostUsd');
    expect(py).toContain('cashPnlUsd');
  });

  it('1.11.803 flags dex-estimated legs so PnL can exclude guesses', () => {
    expect(py).toContain('sizeUsdEstimated');
    expect(py).toContain('proceedsEstimatedLegs');
    expect(py).toContain('costEstimatedLegs');
    expect(py).toContain('cashPnlReliable');
  });

  it('1.11.811 backs off DexScreener and rejects absurd marks', () => {
    expect(py).toContain('LEADER_OBSERVER_DEX_MIN_GAP_MS');
    expect(py).toContain('_dex_backoff_until_ms');
    expect(py).toContain('throttled_local');
    expect(py).toContain('def plausible_mark');
    expect(py).toContain('proceedsMissingLegs');
    expect(py).toContain('pathReliable');
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
