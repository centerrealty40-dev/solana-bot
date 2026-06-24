import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDcTraderForDashboard } from '../scripts-tmp/dc-trader-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('loadDcTraderForDashboard', () => {
  it('does not put watching vaults in open; uses on-chain SOL PnL for sells', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dash-'));
    const journal = path.join(tmpDir, 'journal.jsonl');
    const state = path.join(tmpDir, 'state.json');
    const sig = 'sig-watch-buy-sell';
    fs.writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: '2026-06-24T10:00:00.000Z',
          action: 'watch',
          signature: sig,
          vault: 'vault1',
          mint: 'MintWatchOnly',
          symbol: 'WATCH',
          depositSolEquiv: 50,
        }),
        JSON.stringify({
          ts: '2026-06-24T10:01:00.000Z',
          action: 'buy',
          signature: 'sig-entered',
          mint: 'MintEntered',
          symbol: 'ENT',
          usd: 150,
          entrySolSpent: 2,
          entryPriceUsd: 0.01,
          marketSolUsd: 75,
        }),
        JSON.stringify({
          ts: '2026-06-24T09:00:00.000Z',
          action: 'buy',
          signature: 'sig-closed',
          mint: 'MintClosed',
          symbol: 'TROLL',
          usd: 100,
          entrySolSpent: 1,
          entryPriceUsd: 0.01,
          marketSolUsd: 100,
        }),
        JSON.stringify({
          ts: '2026-06-24T10:02:00.000Z',
          action: 'sell',
          signature: 'sig-closed',
          symbol: 'TROLL',
          ok: true,
          exitReason: 'order_complete',
          entrySolSpent: 1,
          exitSolReceived: 1.5,
          pnlSol: 0.5,
          marketSolUsd: 100,
          pnlPct: 999,
          pnlUsd: 999,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      state,
      JSON.stringify({
        vaults: [
          {
            openSignature: sig,
            vault: 'vault1',
            targetMint: 'MintWatchOnly',
            tokenSymbol: 'WATCH',
            status: 'watching',
            depositSolEquiv: 50,
            lastFillCount: 3,
          },
          {
            openSignature: 'sig-entered',
            vault: 'vault2',
            targetMint: 'MintEntered',
            tokenSymbol: 'ENT',
            status: 'entered',
            enteredAt: '2026-06-24T10:01:00.000Z',
            entrySolSpent: 2,
            entrySizeUsd: 150,
            entryPriceUsd: 0.01,
          },
          {
            openSignature: 'sig-closed',
            vault: 'vault3',
            targetMint: 'MintClosed',
            tokenSymbol: 'TROLL',
            status: 'exited',
            enteredAt: '2026-06-23T01:00:00.000Z',
            entrySolSpent: 1,
            entrySizeUsd: 100,
            maxPctFromEntry: 136,
            exitTriggerReason: 'order_complete',
          },
        ],
      }),
      'utf8',
    );

    const r = loadDcTraderForDashboard(journal, state);
    expect(r.open.map((o) => o.symbol)).toEqual(['ENT']);
    expect(r.watchingOpen.map((o) => o.symbol)).toEqual(['WATCH']);
    expect(r.closed.length).toBe(1);
    const closed = r.closed[0]!;
    expect(closed.pnlSol).toBe(0.5);
    expect(closed.pnlPct).toBeCloseTo(50, 1);
    expect(closed.pnlUsd).toBeCloseTo(50, 0);
    expect(closed.pnlPct).not.toBe(136);
    expect(r.dcTrader.exitBreakdown.order_complete?.count).toBe(1);
  });
});
