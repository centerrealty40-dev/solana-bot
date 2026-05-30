import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCopyTraderJsonlForDashboard } from '../../scripts-tmp/copytrader-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('loadCopyTraderJsonlForDashboard', () => {
  it('parses successful buy/sell round and failed buy', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dash-'));
    const journal = path.join(tmpDir, 'journal.jsonl');
    const state = path.join(tmpDir, 'state.json');
    const base = Date.now() - 600_000;
    fs.writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: base,
          kind: 'leader_buy_scheduled',
          mint: 'Mint1111111111111111111111111111111111111',
          symbol: 'TST',
          sizeUsd: 50,
          leaderPriceUsd: 0.001,
        }),
        JSON.stringify({
          ts: base + 120_000,
          kind: 'copy_buy',
          mode: 'live',
          mint: 'Mint1111111111111111111111111111111111111',
          symbol: 'TST',
          sizeUsd: 50,
          priceUsd: 0.0011,
          ok: true,
          txSignature: 'sigBuy1111111111111111111111111111111111111111111111111111111111111111',
        }),
        JSON.stringify({
          ts: base + 300_000,
          kind: 'copy_sell',
          mode: 'live',
          mint: 'Mint1111111111111111111111111111111111111',
          symbol: 'TST',
          sizeUsd: 50,
          entryPriceUsd: 0.0011,
          exitPriceUsd: 0.0012,
          ok: true,
          txSignature: 'sigSell111111111111111111111111111111111111111111111111111111111111111',
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
  });
});
