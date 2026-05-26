/** 1.11.231 — unit tests для daily summary aggregation. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  aggregateLiveDaily,
  formatSummaryText,
  nextDailyFireMs,
} from '../src/live/daily-summary.js';

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

function makeTmpJsonl(events: Record<string, unknown>[]): string {
  const tmp = path.join(os.tmpdir(), `daily-summary-${Date.now()}-${Math.random()}.jsonl`);
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  return tmp;
}

describe('daily-summary aggregateLiveDaily', () => {
  it('returns empty aggregate for missing file', () => {
    const agg = aggregateLiveDaily({
      jsonlPath: '/non/existing/path.jsonl',
      fromMs: 0,
      toMs: Date.now(),
      maxBytes: 1024,
    });
    expect(agg.evals).toBe(0);
    expect(agg.passes).toBe(0);
    expect(agg.buyAttempts).toBe(0);
  });

  it('aggregates eval, pass, reasons', () => {
    const now = Date.now();
    const tmp = makeTmpJsonl([
      { ts: now / 1000, kind: 'live_discovery_eval', pass: true, reasons: [] },
      { ts: now / 1000, kind: 'live_discovery_eval', pass: false, reasons: ['dip_no_window_pass', 'vol5m_below_min'] },
      { ts: now / 1000, kind: 'live_discovery_eval', pass: false, reasons: ['dip_no_window_pass'] },
      { ts: now / 1000, kind: 'execution_attempt', side: 'buy' },
      { ts: now / 1000, kind: 'execution_result', status: 'sim_err' },
      { ts: now / 1000, kind: 'live_staged_add_cooldown' },
      { ts: now / 1000, kind: 'live_staged_add_auto_denylist' },
      { ts: now / 1000, kind: 'live_priority_fee_boost' },
      { ts: now / 1000, kind: 'live_position_close', netPnlUsd: 12.5 },
      { ts: now / 1000, kind: 'live_position_close', netPnlUsd: -3.25 },
    ]);
    try {
      const agg = aggregateLiveDaily({
        jsonlPath: tmp,
        fromMs: now - 24 * 3600_000,
        toMs: now + 1000,
        maxBytes: 10 * 1024 * 1024,
      });
      expect(agg.evals).toBe(3);
      expect(agg.passes).toBe(1);
      expect(agg.buyAttempts).toBe(1);
      expect(agg.simErrCount).toBe(1);
      expect(agg.stagedCooldownRearms).toBe(1);
      expect(agg.autoDenylistAdds).toBe(1);
      expect(agg.priorityFeeBoosts).toBe(1);
      expect(agg.closedPositions).toBe(2);
      expect(agg.netPnlUsd).toBeCloseTo(9.25, 5);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('skips events outside the window', () => {
    const now = Date.now();
    const tooOld = now - 48 * 3600_000;
    const tmp = makeTmpJsonl([
      { ts: tooOld / 1000, kind: 'live_discovery_eval', pass: true, reasons: [] },
      { ts: now / 1000, kind: 'live_discovery_eval', pass: false, reasons: [] },
    ]);
    try {
      const agg = aggregateLiveDaily({
        jsonlPath: tmp,
        fromMs: now - 24 * 3600_000,
        toMs: now + 1000,
        maxBytes: 1024 * 1024,
      });
      expect(agg.evals).toBe(1);
      expect(agg.passes).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('handles malformed JSON lines gracefully', () => {
    const now = Date.now();
    const tmp = path.join(os.tmpdir(), `daily-summary-bad-${Date.now()}.jsonl`);
    fs.writeFileSync(
      tmp,
      `{"ts":${now / 1000},"kind":"live_discovery_eval","pass":true}\nNOT_JSON\n{ts:invalid}\n`,
      'utf8',
    );
    try {
      const agg = aggregateLiveDaily({
        jsonlPath: tmp,
        fromMs: now - 1000,
        toMs: now + 1000,
        maxBytes: 1024,
      });
      expect(agg.evals).toBe(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('daily-summary formatSummaryText', () => {
  it('produces non-empty summary including pass rate and PnL', () => {
    const text = formatSummaryText({
      evals: 100,
      passes: 5,
      reasonsTop: new Map([['dip_no_window_pass', 50]]),
      buyAttempts: 4,
      buyConfirmed: 2,
      sellConfirmed: 2,
      simErrCount: 10,
      stagedCooldownRearms: 1,
      autoDenylistAdds: 0,
      priorityFeeBoosts: 0,
      closedPositions: 2,
      netPnlUsd: 50.5,
      windowMs: { from: 0, to: 86_400_000 },
    });
    expect(text).toContain('Live-Oscar daily summary');
    expect(text).toContain('5.00%');
    expect(text).toContain('+$50.50');
    expect(text).toContain('dip_no_window_pass');
  });
});

describe('nextDailyFireMs', () => {
  it('returns next 00:00 MSK from a given UTC time', () => {
    /** 2026-05-20 12:00 UTC = 15:00 MSK. Next 00:00 MSK = 2026-05-21 00:00 MSK = 2026-05-20 21:00 UTC. */
    const now = Date.UTC(2026, 4, 20, 12, 0, 0);
    const next = nextDailyFireMs(now, 0);
    expect(next).toBe(Date.UTC(2026, 4, 20, 21, 0, 0));
  });

  it('rolls over when fire-time has passed today', () => {
    /** 2026-05-20 23:30 MSK = 20:30 UTC. Today's 00:00 MSK already passed → next = tomorrow. */
    const now = Date.UTC(2026, 4, 20, 20, 30, 0);
    const next = nextDailyFireMs(now, 0);
    expect(next).toBe(Date.UTC(2026, 4, 20, 21, 0, 0));
  });
});
