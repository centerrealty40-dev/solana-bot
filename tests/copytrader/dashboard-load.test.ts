import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCopyTraderJsonlForDashboard, compactCopyTraderCyclesForDashboard } from '../../scripts-tmp/copytrader-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

const LEADER_BUY_SIG = 'LeaderBuy111111111111111111111111111111111111111111111111111111111111';
const LEADER_SELL_SIG = 'LeaderSell11111111111111111111111111111111111111111111111111111111111';
const OUR_BUY_SIG = 'sigBuy1111111111111111111111111111111111111111111111111111111111111111';
const OUR_SELL_SIG = 'sigSell111111111111111111111111111111111111111111111111111111111111111';

describe('loadCopyTraderJsonlForDashboard', () => {
  it('parses successful buy/sell round and failed buy with leader-order cycles', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dash-'));
    const journal = path.join(tmpDir, 'journal.jsonl');
    const state = path.join(tmpDir, 'state.json');
    const base = Date.now() - 600_000;
    const mint = 'Mint1111111111111111111111111111111111111';
    fs.writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: base,
          kind: 'leader_buy_scheduled',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          leaderPriceUsd: 0.001,
          leaderSignature: LEADER_BUY_SIG,
        }),
        JSON.stringify({
          ts: base + 120_000,
          kind: 'copy_buy',
          mode: 'live',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          priceUsd: 0.0011,
          ok: true,
          leaderSignature: LEADER_BUY_SIG,
          txSignature: OUR_BUY_SIG,
        }),
        JSON.stringify({
          ts: base + 240_000,
          kind: 'leader_sell_scheduled',
          mint,
          symbol: 'TST',
          leaderSellFraction: 1,
          leaderSignature: LEADER_SELL_SIG,
        }),
        JSON.stringify({
          ts: base + 300_000,
          kind: 'copy_sell',
          mode: 'live',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          entryPriceUsd: 0.0011,
          exitPriceUsd: 0.0012,
          ok: true,
          leaderSignature: LEADER_SELL_SIG,
          txSignature: OUR_SELL_SIG,
        }),
        JSON.stringify({
          ts: base + 400_000,
          kind: 'copy_buy',
          mode: 'live',
          mint: 'Mint2222222222222222222222222222222222222',
          symbol: 'BAD',
          sizeUsd: 50,
          priceUsd: 0.002,
          ok: false,
          reason: 'sim_failed',
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      state,
      JSON.stringify({ pendingBuys: [{ id: 'pb1' }], pendingSells: [], positions: {} }),
      'utf8',
    );

    const r = loadCopyTraderJsonlForDashboard(journal, state);
    expect(r.open.length).toBe(0);
    expect(r.closed.length).toBe(1);
    expect(r.copyTrader.buysOk).toBe(1);
    expect(r.copyTrader.buysFail).toBe(1);
    expect(r.copyTrader.sellsOk).toBe(1);
    expect(r.copyTrader.pendingBuys).toBe(1);
    expect(r.failReasons.some((x) => x.reason.includes('sim_failed'))).toBe(true);

    expect(r.copyTrader.cycles.length).toBeGreaterThanOrEqual(1);
    const closedCycle = r.copyTrader.cycles.find((c) => c.mint === mint);
    expect(closedCycle?.status).toBe('closed');
    expect(closedCycle?.leaderEntry.sig).toBe(LEADER_BUY_SIG);
    expect(closedCycle?.leaderExit?.sig).toBe(LEADER_SELL_SIG);
    expect(closedCycle?.ourEntry?.sig).toBe(OUR_BUY_SIG);
    expect(closedCycle?.ourExit?.sig).toBe(OUR_SELL_SIG);

    const tl = r.closed[0]!.__timeline as Array<{ leaderTxSignature?: string; ourTxSignature?: string }>;
    const openEv = tl.find((e) => e.ourTxSignature === OUR_BUY_SIG);
    expect(openEv?.leaderTxSignature).toBe(LEADER_BUY_SIG);
    const closeEv = tl.find((e) => e.ourTxSignature === OUR_SELL_SIG);
    expect(closeEv?.leaderTxSignature).toBe(LEADER_SELL_SIG);
  });

  it('hides stale pending_our_buy cycles when mint is not in pending queue', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dash-'));
    const journal = path.join(tmpDir, 'journal.jsonl');
    const state = path.join(tmpDir, 'state.json');
    const base = Date.now() - 600_000;
    const mint = 'Mint1111111111111111111111111111111111111';
    fs.writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: base,
          kind: 'leader_buy_scheduled',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          leaderSignature: LEADER_BUY_SIG,
        }),
        JSON.stringify({
          ts: base + 60_000,
          kind: 'buy_skipped',
          mint,
          symbol: 'TST',
          leaderSignature: LEADER_BUY_SIG,
        }),
        JSON.stringify({
          ts: base + 120_000,
          kind: 'leader_buy_scheduled',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          leaderSignature: 'LeaderBuy222222222222222222222222222222222222222222222222222222222222',
        }),
        JSON.stringify({
          ts: base + 180_000,
          kind: 'copy_buy',
          mode: 'live',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          priceUsd: 0.001,
          ok: true,
          leaderSignature: 'LeaderBuy222222222222222222222222222222222222222222222222222222222222',
          txSignature: OUR_BUY_SIG,
        }),
        JSON.stringify({
          ts: base + 300_000,
          kind: 'copy_sell',
          mode: 'live',
          mint,
          symbol: 'TST',
          sizeUsd: 50,
          entryPriceUsd: 0.001,
          exitPriceUsd: 0.0011,
          ok: true,
          txSignature: OUR_SELL_SIG,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(state, JSON.stringify({ pendingBuys: [], pendingSells: [], positions: {} }), 'utf8');

    const r = loadCopyTraderJsonlForDashboard(journal, state);
    expect(r.open.length).toBe(0);
    expect(r.closed.length).toBe(1);
    expect(r.copyTrader.cycles.every((c) => c.status !== 'pending_our_buy')).toBe(true);
    expect(r.copyTrader.cycles.filter((c) => c.mint === mint).length).toBe(1);
    expect(r.copyTrader.cycles[0]!.status).toBe('closed');
  });

  it('compactCopyTraderCyclesForDashboard keeps pending when mint is queued', () => {
    const mint = 'Mint1111111111111111111111111111111111111';
    const pending = compactCopyTraderCyclesForDashboard(
      [
        {
          cycleId: 'a',
          mint,
          symbol: 'TST',
          startedTs: 1,
          status: 'pending_our_buy',
          leaderEntry: { sig: 'x', ts: 1, sizeUsd: 50, priceUsd: null },
          buyAttempts: 1,
        },
        {
          cycleId: 'b',
          mint,
          symbol: 'TST',
          startedTs: 2,
          status: 'closed',
          leaderEntry: { sig: 'y', ts: 2, sizeUsd: 50, priceUsd: null },
          buyAttempts: 0,
          ourEntry: { ok: true, ts: 3, sig: 'z', sizeUsd: 50, failReason: null },
          ourExit: { ok: true, ts: 4, sig: 'w', sizeUsd: 50, pnlUsd: 1, pnlPct: 2, failReason: null },
          closedTs: 4,
        },
      ],
      new Set([mint]),
    );
    expect(pending.length).toBe(2);
  });

  it('corrects legacy live sell that stored proceeds as exitPriceUsd', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dash-'));
    const journal = path.join(tmpDir, 'journal.jsonl');
    const base = Date.now() - 600_000;
    const mint = 'Mint3333333333333333333333333333333333333';
    fs.writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: base,
          kind: 'copy_buy',
          mode: 'live',
          mint,
          symbol: 'WCUP',
          sizeUsd: 50,
          priceUsd: 0.005,
          ok: true,
          txSignature: 'sigBuy3333333333333333333333333333333333333333333333333333333333333333',
        }),
        JSON.stringify({
          ts: base + 300_000,
          kind: 'copy_sell',
          mode: 'live',
          mint,
          symbol: 'WCUP',
          sizeUsd: 50,
          entryPriceUsd: 0.005,
          exitPriceUsd: 49.5,
          ok: true,
          txSignature: 'sigSell333333333333333333333333333333333333333333333333333333333333333',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const r = loadCopyTraderJsonlForDashboard(journal);
    expect(r.closed.length).toBe(1);
    expect(r.closed[0]!.pnlPct).toBe(-1);
    expect(r.closed[0]!.pnlUsd).toBe(-0.5);
  });
});
