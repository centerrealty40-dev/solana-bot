import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DASHBOARD_PANEL_ORDER,
  mergeDashboardStrategyPanels,
  type DashboardPaper2StrategyRow,
  loadLiveOscarJsonlAsPaper2,
  resolveLiveOscarDashboardStrategyId,
  resolveLiveOscarOpenSnapshotPath,
  selectRecentClosedRowsForDashboard,
  synthesizeTimelineFromLiveOpenTrade,
  superbotJsonlIsLiveOscarFormat,
  LIVE_OSCAR_PRESET_C_STRATEGY_ID,
  paper2OpenItemFromLiveOpenTrade,
} from '../scripts-tmp/dashboard-server.js';
import {
  aggregateSuperbotJsonlForDashboard,
  formatSuperbotMskTs,
  loadSuperbotJsonlForDashboard,
} from '../scripts-tmp/superbot-dashboard.js';

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

describe('DASHBOARD_PANEL_ORDER with superbot', () => {
  it('includes superbot as second tile', () => {
    expect(DASHBOARD_PANEL_ORDER).toEqual([
      'live-oscar',
      'superbot',
      'dc-trader',
      'hl-oscar-perp',
      'live-lera',
      'hl-oscar-majors',
    ]);
  });

  it('mergeDashboardStrategyPanels fills six strategies', () => {
    const merged = mergeDashboardStrategyPanels([row('superbot', 7), row('live-oscar', 1)]);
    expect(merged.length).toBe(6);
    expect(merged.map((s) => s.strategyId)).toEqual([...DASHBOARD_PANEL_ORDER]);
    expect(merged[1]!.totalPnlUsd).toBe(7);
  });
});

describe('loadSuperbotJsonlForDashboard', () => {
  it('builds MSK-friendly timeline from ext sell → buy → close', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbot-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    const base = Date.UTC(2026, 5, 13, 10, 0, 0);
    const mint = 'So11111111111111111111111111111111111111112';
    const pool = 'Pool111111111111111111111111111111111111111';
    const seller = 'Sell111111111111111111111111111111111111111';
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base,
          kind: 'ext_sell_detected',
          mint,
          pool,
          sellUsd: 420,
          extSellUsd: 420,
          sellSignature: 'sigExtSell111111111111111111111111111111111111111111111111111111111',
          sellerWallet: seller,
          triggerPool: pool,
          priceUsd: 0.00001,
        }),
        JSON.stringify({
          ts: base + 500,
          kind: 'race_buy_ok',
          mint,
          pool,
          sellUsd: 420,
          extSellUsd: 420,
          sellSignature: 'sigExtSell111111111111111111111111111111111111111111111111111111111',
          sellerWallet: seller,
          triggerPool: pool,
          legUsd: 5,
          fillPriceUsd: 0.000012,
          buyPrice: 0.000012,
          marketCapUsd: 180000,
          mcapAtBuy: 180000,
          txSignature: 'sigBuy1111111111111111111111111111111111111111111111111111111111111111',
          detectMs: 80,
          detectToRaceMs: 420,
        }),
        JSON.stringify({
          ts: base + 60_000,
          kind: 'position_close',
          mint,
          pool,
          sellReason: 'TP2',
          exitReason: 'tp2_full',
          sellPriceUsd: 0.0000144,
          pnlPct: 20,
          pnlUsd: 1,
          investedUsd: 5,
          txSignature: 'sigSell111111111111111111111111111111111111111111111111111111111111111',
        }),
        JSON.stringify({
          ts: base + 120_000,
          kind: 'heartbeat',
          openCount: 0,
          signalsSeen: 10,
          racesAttempted: 3,
          racesBlocked: 2,
          streamConnected: true,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const agg = aggregateSuperbotJsonlForDashboard(fp);
    expect(agg.strategyId).toBe('superbot');
    expect(agg.closedCount).toBe(1);
    expect(agg.superbot?.signalsSeen).toBe(10);
    expect(agg.superbot?.racesBlocked).toBe(2);

    const ll = loadSuperbotJsonlForDashboard(fp);
    expect(ll.open.length).toBe(0);
    expect(ll.closed.length).toBe(1);
    const closed = ll.closed[0]!;
    const tl = closed.__timeline as Array<{ kind: string; label: string; reason: string | null }>;
    expect(tl.length).toBeGreaterThanOrEqual(3);
    expect(tl[0]!.label).toContain('420');
    expect(tl[0]!.label).toContain('Sell');
    expect(tl[1]!.kind).toBe('open');
    expect(tl[2]!.kind).toBe('close');
    expect(tl[2]!.reason).toBe('TP2');
    expect(formatSuperbotMskTs(base)).toMatch(/\d{2}\.\d{2}/);
  });
});

describe('SuperBot preset-c live journal', () => {
  it('detects preset-c strategy id from journal path', () => {
    expect(resolveLiveOscarDashboardStrategyId('/data/live/live-oscar-preset-c.jsonl')).toBe(
      LIVE_OSCAR_PRESET_C_STRATEGY_ID,
    );
    expect(superbotJsonlIsLiveOscarFormat('/data/live/live-oscar-preset-c.jsonl')).toBe(true);
  });

  it('builds preset-c open/close timeline labels from live JSONL', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbot-preset-c-'));
    const fp = path.join(tmpDir, 'live-oscar-preset-c.jsonl');
    const base = Date.UTC(2026, 5, 23, 12, 0, 0);
    const mint = 'Mint111111111111111111111111111111111111111';
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base,
          channel: 'live',
          kind: 'live_position_open',
          mint,
          openTrade: {
            symbol: 'TEST',
            metricType: 'mc',
            entryTs: base,
            entryMcUsd: 2_500_000,
            totalInvestedUsd: 100,
            liveOscarMcapTier: 'low',
            liveExitPolicyId: 'wave_b_v1',
            legs: [{ sizeUsd: 100, marketPrice: 0.0025, reason: 'entry_split' }],
          },
        }),
        JSON.stringify({
          ts: base + 120_000,
          channel: 'live',
          kind: 'live_position_close',
          mint,
          closedTrade: {
            symbol: 'TEST',
            exitTs: base + 120_000,
            exitReason: 'TRAIL',
            pnlPct: 8.5,
            netPnlUsd: 6.2,
            totalInvestedUsd: 100,
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const ll = loadLiveOscarJsonlAsPaper2(fp);
    expect(ll.closed.length).toBe(1);
    const tl = ll.closed[0]!.__timeline as Array<{ kind: string; label: string; contextNote?: string }>;
    expect(tl[0]!.label).toContain('Preset C');
    expect(tl[0]!.label).toContain('TG gate');
    expect(tl[0]!.label).toContain('лоу-капа');
    expect(tl[0]!.contextNote).toContain('deferred −10%');
    const closeEv = tl.find((e) => e.kind === 'close');
    expect(closeEv?.label).toContain('preset_c_scalp_v1');
    expect(closeEv?.label).toContain('TRAIL');
    expect(closeEv?.contextNote).toContain('preset_c_scalp_v1');
  });

  it('resolves preset-c open snapshot path from journal path', () => {
    expect(resolveLiveOscarOpenSnapshotPath('/data/live/live-oscar-preset-c.jsonl')).toMatch(
      /live-oscar-preset-c-open-snapshot\.json$/,
    );
  });

  it('parses execution_attempt quote slip onto open row', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbot-exec-slip-'));
    const fp = path.join(tmpDir, 'live-oscar-preset-c.jsonl');
    const base = Date.UTC(2026, 5, 24, 8, 0, 0);
    const mint = 'MintExec111111111111111111111111111111111111';
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base,
          channel: 'live',
          kind: 'execution_attempt',
          side: 'buy',
          mint,
          intentId: 'intent-1',
          quoteSnapshot: { provider: 'jupiter', slippageBps: 50, priceImpactPct: '0.00125' },
        }),
        JSON.stringify({
          ts: base + 1000,
          channel: 'live',
          kind: 'live_position_open',
          mint,
          openTrade: {
            symbol: 'SLIP',
            metricType: 'price',
            entryTs: base + 1000,
            totalInvestedUsd: 50,
            avgEntryMarket: 0.01,
            legs: [{ ts: base + 1000, marketPrice: 0.01, sizeUsd: 50, reason: 'open' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ll = loadLiveOscarJsonlAsPaper2(fp);
    expect(ll.open.length).toBe(1);
    expect(ll.open[0]!.entryPriceVerifySource).toBe('jupiter');
    expect(ll.open[0]!.entryPriceVerifySlipPct).toBe(0.5);
    expect(ll.open[0]!.entryPriceVerifyImpactPct).toBe(0.125);
  });

  it('synthesizes open timeline legs from openTrade snapshot shape', () => {
    const mint = 'MintSynth111111111111111111111111111111111';
    const base = Date.UTC(2026, 5, 24, 9, 0, 0);
    const tl = synthesizeTimelineFromLiveOpenTrade(mint, {
      symbol: 'SYN',
      metricType: 'price',
      entryTs: base,
      liveOscarMcapTier: 'low',
      legs: [
        { ts: base, marketPrice: 0.002, sizeUsd: 50, reason: 'open' },
        { ts: base + 60_000, marketPrice: 0.0021, sizeUsd: 50, reason: 'entry_split', triggerPct: 0.05 },
      ],
      partialSells: [],
      totalInvestedUsd: 100,
    }, LIVE_OSCAR_PRESET_C_STRATEGY_ID);
    expect(tl.length).toBe(2);
    expect(tl[0]!.kind).toBe('open');
    expect(tl[0]!.label).toContain('Preset C');
    expect(tl[0]!.spotPxUsd).toBe(0.002);
    expect(tl[0]!.amountUsd).toBe(50);
    expect(tl[1]!.spotPxUsd).toBe(0.0021);
    expect(tl[1]!.amountUsd).toBe(50);
  });

  it('shows fee PnL for RECONCILE_ORPHAN closes (net 0 in journal)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbot-reconcile-'));
    const fp = path.join(tmpDir, 'live-oscar-preset-c.jsonl');
    const base = Date.UTC(2026, 5, 24, 10, 0, 0);
    const mint = 'MintReco1111111111111111111111111111111111';
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base + 120_000,
          channel: 'live',
          kind: 'live_position_close',
          mint,
          closedTrade: {
            symbol: 'RECO',
            entryTs: base,
            exitTs: base + 120_000,
            exitReason: 'RECONCILE_ORPHAN',
            totalInvestedUsd: 100,
            netPnlUsd: 0,
            pnlPct: 0,
            grossPnlUsd: -0.8,
            grossPnlPct: -0.8,
            avgEntryMarket: 0.001,
            avgEntry: 0.00101,
            effective_entry_price: 0.00101,
            theoretical_entry_price: 0.001,
            effective_exit_price: 0.00101,
            theoretical_exit_price: 0.001,
            lastObservedPriceUsd: 0.0009,
            durationMin: 2,
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ll = loadLiveOscarJsonlAsPaper2(fp);
    expect(ll.closed.length).toBe(1);
    const c = ll.closed[0]!;
    expect(c.netPnlUsd).toBe(-0.8);
    expect(c.entryPriceUsd).toBe(0.001);
    expect(c.exitPriceUsd).toBe(0.0009);
  });

  it('infers closed when wallet drained after sell attempts without live_position_close', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbot-wallet-zombie-'));
    const fp = path.join(tmpDir, 'live-oscar-preset-c.jsonl');
    const base = Date.UTC(2026, 6, 27, 10, 0, 0);
    const mint = 'MintZombie1111111111111111111111111111111';
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          ts: base,
          channel: 'live',
          kind: 'live_position_open',
          mint,
          openTrade: {
            symbol: 'ZOM',
            metricType: 'price',
            entryTs: base,
            entryMcUsd: 0.001,
            legs: [{ ts: base, marketPrice: 0.001, sizeUsd: 200, reason: 'open' }],
            partialSells: [],
            totalInvestedUsd: 200,
            avgEntry: 0.001,
            avgEntryMarket: 0.001,
            remainingFraction: 1,
            lastObservedPriceUsd: 0.0005,
          },
        }),
        JSON.stringify({
          ts: base + 60_000,
          channel: 'live',
          kind: 'execution_attempt',
          intentId: 'sell-intent-1',
          side: 'sell',
          mint,
          intendedUsd: 200,
          targetPriceUsd: 0.00048,
        }),
        JSON.stringify({
          ts: base + 61_000,
          channel: 'live',
          kind: 'execution_skip',
          intentId: 'sell-intent-1',
          reason: 'wallet_spl_balance_zero',
          detail: JSON.stringify({ mint, intentKind: 'sell_full' }),
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ll = loadLiveOscarJsonlAsPaper2(fp);
    expect(ll.open.some((o) => o.mint === mint)).toBe(false);
    expect(ll.closed.some((c) => c.mint === mint && c.exitReason === 'KILLSTOP')).toBe(true);
  });

  it('selectRecentClosedRowsForDashboard picks newest closes, not journal append order', () => {
    const base = Date.UTC(2026, 5, 20, 12, 0, 0);
    const rows = Array.from({ length: 25 }, (_, i) => ({
      mint: `Mint${i}`,
      symbol: i === 24 ? 'world' : `SYM${i}`,
      exitTs: base + i * 60_000,
    }));
    const picked = selectRecentClosedRowsForDashboard(rows, 20);
    expect(picked).toHaveLength(20);
    expect(picked[0]!.symbol).toBe('world');
    expect(picked[0]!.exitTs).toBe(base + 24 * 60_000);
    expect(picked.some((c) => c.symbol === 'SYM0')).toBe(false);
  });
});
