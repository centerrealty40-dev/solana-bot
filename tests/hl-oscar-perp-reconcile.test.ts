import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HlOscarPerpConfig } from '../src/hyperliquid/oscar-perp/config.js';
import {
  loadOscarOpenModesFromJournal,
  loadOscarOpensFromJournal,
} from '../src/hyperliquid/oscar-perp/journal.js';
import { reconcileOscarOpensForLiveMode } from '../src/hyperliquid/oscar-perp/reconcile.js';
import { createOscarTraderState } from '../src/hyperliquid/oscar-perp/trader.js';
import * as hyperliquidMeta from '../src/hyperliquid/twap/hyperliquid-meta.js';

let tmpDir: string | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

function paperOpenRow(id: string, coin: string, ts: number): string {
  return JSON.stringify({
    kind: 'open',
    ts,
    id,
    coin,
    displaySymbol: coin,
    legIndex: 1,
    signalPrice: 1,
    fillPx: 1,
    grossUsd: 13.64,
    marginUsd: 6.82,
    dipPct: -10,
    impulsePct: 12,
    windowMin: 360,
    mode: 'dry_run',
  });
}

describe('reconcileOscarOpensForLiveMode', () => {
  it('closes dry_run journal opens when runtime mode is live', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-oscar-reconcile-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    const t0 = Date.now() - 60_000;
    fs.writeFileSync(
      journalPath,
      [paperOpenRow('pos-1', 'SYRUP', t0), paperOpenRow('pos-2', 'S', t0 + 1)].join('\n') + '\n',
      'utf8',
    );

    vi.spyOn(hyperliquidMeta, 'fetchHlClearinghousePositions').mockResolvedValue([]);

    const cfg = {
      mode: 'live',
      journalPath,
      masterAddress: '0x1234567890123456789012345678901234567890',
    } as HlOscarPerpConfig;
    const state = createOscarTraderState(journalPath);
    expect(state.opens.size).toBe(2);

    const result = await reconcileOscarOpensForLiveMode({ cfg, state });
    expect(result.paperClosed).toBe(2);
    expect(state.opens.size).toBe(0);

    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    const closes = lines.slice(2).map((ln) => JSON.parse(ln) as { kind: string; reason: string });
    expect(closes.every((c) => c.kind === 'close' && c.reason === 'PAPER_STALE')).toBe(true);
    expect(loadOscarOpensFromJournal(journalPath).size).toBe(0);
  });

  it('tracks open modes from journal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-oscar-modes-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    fs.writeFileSync(
      journalPath,
      [
        paperOpenRow('pos-a', 'BTC', Date.now()),
        JSON.stringify({
          kind: 'open',
          ts: Date.now(),
          id: 'pos-b',
          coin: 'ETH',
          displaySymbol: 'ETH',
          legIndex: 1,
          signalPrice: 1,
          fillPx: 1,
          grossUsd: 15,
          marginUsd: 7.5,
          dipPct: -10,
          impulsePct: 12,
          windowMin: 120,
          mode: 'live',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const modes = loadOscarOpenModesFromJournal(journalPath);
    expect(modes.get('pos-a')).toBe('dry_run');
    expect(modes.get('pos-b')).toBe('live');
  });
});
