import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DASHBOARD_PANEL_ORDER,
  aggregateLiveOscarJsonlForDashboard,
  mergeDashboardStrategyPanels,
  type DashboardPaper2StrategyRow,
} from '../scripts-tmp/dashboard-server.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

function row(id: string, total: number): DashboardPaper2StrategyRow {
  return {
    strategyId: id,
    file: '/x.jsonl',
    openCount: 0,
    closedCount: 0,
    startedAt: Date.now(),
    lastTs: Date.now(),
    hoursOfData: 1,
    sumPnlUsd: total,
    realizedPnlUsd: total,
    unrealizedPnlUsd: 0,
    totalPnlUsd: total,
    winRate: 0,
    avgPnl: 0,
    avgPeak: 0,
    bestPnlUsd: 0,
    worstPnlUsd: 0,
    unrealizedUsd: 0,
    exits: {},
    exitsBreakdown: {},
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    open: [],
    recentClosed: [],
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
  };
}

describe('mergeDashboardStrategyPanels', () => {
  it('orders Live → Oscar → Oscar regime → Deep Runner → Dno regardless of input PnL order', () => {
    const merged = mergeDashboardStrategyPanels([
      row('pt1-diprunner', 300),
      row('live-oscar', 50),
      row('pt1-oscar', 200),
      row('pt1-oscar-regime', 77),
      row('pt1-dno', 100),
    ]);
    expect(merged.map((s) => s.strategyId)).toEqual([...DASHBOARD_PANEL_ORDER]);
    expect(merged[0]!.totalPnlUsd).toBe(50);
    expect(merged[1]!.totalPnlUsd).toBe(200);
    expect(merged[2]!.totalPnlUsd).toBe(77);
    expect(merged[3]!.totalPnlUsd).toBe(300);
    expect(merged[4]!.totalPnlUsd).toBe(100);
  });

  it('fills missing strategies with empty placeholders', () => {
    const merged = mergeDashboardStrategyPanels([row('live-oscar', 1)]);
    expect(merged.length).toBe(5);
    expect(merged.map((s) => s.strategyId)).toEqual([...DASHBOARD_PANEL_ORDER]);
    expect(merged[1]!.openCount).toBe(0);
  });
});

describe('aggregateLiveOscarJsonlForDashboard', () => {
  it('parses heartbeat and execution counters', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dash-'));
    const fp = path.join(tmpDir, 'live.jsonl');
    const base = Date.now() - 60_000;
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base,
          strategyId: 'live-oscar',
          channel: 'live',
          liveSchema: 1,
          kind: 'heartbeat',
          uptimeSec: 1,
          openPositions: 2,
          closedTotal: 3,
          liveStrategyEnabled: true,
          executionMode: 'simulate',
        }),
        JSON.stringify({
          ts: base + 1000,
          strategyId: 'live-oscar',
          channel: 'live',
          liveSchema: 1,
          kind: 'execution_attempt',
          intentId: '00000000-0000-4000-8000-000000000001',
          side: 'buy',
          mint: 'So11111111111111111111111111111111111111112',
          executionMode: 'simulate',
        }),
        JSON.stringify({
          ts: base + 2000,
          strategyId: 'live-oscar',
          channel: 'live',
          liveSchema: 1,
          kind: 'execution_result',
          intentId: '00000000-0000-4000-8000-000000000001',
          status: 'sim_ok',
          simulated: true,
          txSignature: null,
          unitsConsumed: 100,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const r = aggregateLiveOscarJsonlForDashboard(fp);
    expect(r.strategyId).toBe('live-oscar');
    expect(r.openCount).toBe(2);
    expect(r.closedCount).toBe(3);
    expect(r.evals1h).toBeGreaterThanOrEqual(1);
    expect(r.passed1h).toBeGreaterThanOrEqual(1);
  });

  it('parses reconcile boot heartbeat and live_reconcile_report', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dash-'));
    const fp = path.join(tmpDir, 'live.jsonl');
    const base = Date.now() - 120_000;
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base,
          strategyId: 'live-oscar',
          channel: 'live',
          liveSchema: 1,
          kind: 'heartbeat',
          uptimeSec: 10,
          openPositions: 1,
          closedTotal: 0,
          liveStrategyEnabled: true,
          executionMode: 'live',
          reconcileBootStatus: 'ok',
          reconcileMintsDivergent: [],
          reconcileChainOnlyMints: ['MintX'],
          journalReplayTruncated: false,
        }),
        JSON.stringify({
          ts: base + 5000,
          strategyId: 'live-oscar',
          channel: 'live',
          liveSchema: 2,
          kind: 'live_reconcile_report',
          ok: true,
          reconcileStatus: 'ok',
          txAnchorSample: { checked: 2, notFound: ['sig1'], rpcErrors: 0 },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const r = aggregateLiveOscarJsonlForDashboard(fp);
    expect(r.liveReconcileBoot?.status).toBe('ok');
    expect(r.liveReconcileBoot?.chainOnlyCount).toBe(1);
    expect(r.liveReconcileReport?.ok).toBe(true);
    expect(r.liveReconcileReport?.txAnchorMissing).toBe(1);
  });
});
