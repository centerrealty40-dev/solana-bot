import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HlOscarPerpConfig } from '../src/hyperliquid/oscar-perp/config.js';
import {
  loadOscarOpenModesFromJournal,
  loadOscarOpensFromJournal,
} from '../src/hyperliquid/oscar-perp/journal.js';
import { reconcileOscarWithHl } from '../src/hyperliquid/oscar-perp/reconcile.js';
import { createOscarTraderState } from '../src/hyperliquid/oscar-perp/trader.js';
import {
  loadCoinsFromJournalHistory,
  reconcileWithTracker,
} from '../src/hyperliquid/oscar-reconcile-core.js';
import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import { createDryRunClient } from '../src/hyperliquid/twap/live/exchange-dry-run.js';
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

describe('oscar HL reconcile ground truth', () => {
  it('closes dry_run journal opens at startup (purgePaperOpens)', async () => {
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
      leverage: 2,
    } as HlOscarPerpConfig;
    const state = createOscarTraderState(journalPath);
    const twapCfg = loadHlTwapLiveConfig();
    const client = createDryRunClient(twapCfg);
    await client.init();

    const result = await reconcileOscarWithHl({
      cfg,
      client,
      state,
      universe: [],
      purgePaperOpens: true,
    });
    expect(result.paperClosed).toBe(2);
    expect(state.opens.size).toBe(0);

    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const closes = lines.slice(2).map((ln) => JSON.parse(ln) as { kind: string; reason: string });
    expect(closes.every((c) => c.kind === 'close' && c.reason === 'PAPER_STALE')).toBe(true);
    expect(loadOscarOpensFromJournal(journalPath).size).toBe(0);
  });

  it('adopts HL orphan in universe (MANTA-class bug prevention)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-oscar-adopt-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    fs.writeFileSync(journalPath, '', 'utf8');

    vi.spyOn(hyperliquidMeta, 'fetchHlClearinghousePositions').mockResolvedValue([
      {
        coin: 'MANTA',
        displaySymbol: 'MANTA',
        side: 'buy' as const,
        size: 100,
        entryPx: 0.85,
        notionalUsd: 130,
        unrealizedPnlUsd: -5,
      },
    ]);

    const twapCfg = loadHlTwapLiveConfig();
    const client = createDryRunClient(twapCfg);
    await client.init();
    client.seedPosition('MANTA', 100);

    const state = createOscarTraderState(journalPath);

    const result = await reconcileWithTracker({
      logPrefix: '[test]',
      mode: 'live',
      masterAddress: '0xabc',
      client,
      state,
      universeCoins: new Set(['MANTA']),
      journalCoins: loadCoinsFromJournalHistory(journalPath),
      leverage: 2,
      markPxByCoin: new Map([['MANTA', 0.85]]),
      appendJournal: (row) => fs.appendFileSync(journalPath, `${JSON.stringify(row)}\n`, 'utf8'),
    });

    expect(result.adopted).toBe(1);
    expect(state.opens.size).toBe(1);
    expect(state.openByCoin.get('MANTA')).toBeTruthy();

    const reloaded = loadOscarOpensFromJournal(journalPath);
    expect(reloaded.size).toBe(1);
    const pos = [...reloaded.values()][0]!;
    expect(pos.totalGrossUsd).toBe(130);
    expect(pos.coin).toBe('MANTA');
  });

  it('closes journal phantom when HL has no position', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-oscar-phantom-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        kind: 'open',
        ts: Date.now(),
        id: 'live-1',
        coin: 'ARB',
        displaySymbol: 'ARB',
        legIndex: 1,
        signalPrice: 1,
        fillPx: 1,
        grossUsd: 30,
        marginUsd: 15,
        dipPct: -10,
        impulsePct: 12,
        windowMin: 120,
        mode: 'live',
      }) + '\n',
      'utf8',
    );

    vi.spyOn(hyperliquidMeta, 'fetchHlClearinghousePositions').mockResolvedValue([]);

    const state = createOscarTraderState(journalPath);
    const twapCfg = loadHlTwapLiveConfig();
    const client = createDryRunClient(twapCfg);
    await client.init();

    const result = await reconcileWithTracker({
      logPrefix: '[test]',
      mode: 'live',
      masterAddress: '0xabc',
      client,
      state,
      universeCoins: new Set(['ARB']),
      journalCoins: loadCoinsFromJournalHistory(journalPath),
      leverage: 2,
      markPxByCoin: new Map(),
      appendJournal: (row) => fs.appendFileSync(journalPath, `${JSON.stringify(row)}\n`, 'utf8'),
    });

    expect(result.exchangeOrphans).toBe(1);
    expect(state.opens.size).toBe(0);
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
