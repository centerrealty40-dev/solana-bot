/**
 * DdPrHY RCA — ghost PERIODIC_HEAL loop after copy_oscar_exit_handoff + Oscar close on empty wallet.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptCopyLeaderExitOpens } from '../../src/live/copy-leader-exit-adopt.js';
import {
  finalizeCopyLeaderOscarHandoffClose,
  readCopyLeaderMintAttribution,
  resetOscarHandoffClosedMintCache,
} from '../../src/live/copy-leader-attribution.js';
import {
  onOscarFullCloseCopyHandoffMint,
  shouldSkipCopyLeaderExitAdopt,
} from '../../src/live/copy-oscar-handoff-lifecycle.js';
import { loadPaperTraderConfig } from '../../src/papertrader/config.js';
import type { ClosedTrade, OpenTrade } from '../../src/papertrader/types.js';

const DDPRHY_MINT = 'DdPrHY1111111111111111111111111111111111111';

describe('copy-leader handoff ghost heal (DdPrHY)', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    resetOscarHandoffClosedMintCache();
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  function writeCopyState(mint: string, promotedAt: number): string {
    const fp = path.join(os.tmpdir(), `ct-ghost-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(
      fp,
      JSON.stringify({
        positions: {
          [mint]: {
            mint,
            symbol: 'DDP',
            entryTs: promotedAt - 120_000,
            entryPriceUsd: 0.003,
            sizeUsd: 250,
            entryDeployedCostUsd: 250,
            positionSource: 'copy_leader',
            oscarPromotedAt: promotedAt,
            tokenRaw: '0',
          },
        },
        leaderLedger: {
          [mint]: { tokenRaw: '0' },
        },
      }),
      'utf8',
    );
    tmpFiles.push(fp);
    return fp;
  }

  it('clears copy-trader state when Oscar closes handoff mint', () => {
    const promotedAt = Date.now() - 300_000;
    const statePath = writeCopyState(DDPRHY_MINT, promotedAt);

    expect(readCopyLeaderMintAttribution(DDPRHY_MINT, statePath)?.oscarPromotedAt).toBe(promotedAt);

    const cleared = onOscarFullCloseCopyHandoffMint({
      mint: DDPRHY_MINT,
      openTrade: { copyToOscarPromoted: true } as OpenTrade,
      statePath,
    });
    expect(cleared).toBe(true);
    expect(readCopyLeaderMintAttribution(DDPRHY_MINT, statePath)).toBeNull();
  });

  it('does not re-adopt after Oscar close on empty wallet', () => {
    const promotedAt = Date.now() - 300_000;
    const statePath = writeCopyState(DDPRHY_MINT, promotedAt);
    finalizeCopyLeaderOscarHandoffClose({ mint: DDPRHY_MINT, statePath });

    const closed: ClosedTrade[] = [
      {
        mint: DDPRHY_MINT,
        symbol: 'DDP',
        exitTs: promotedAt + 60_000,
        entryTs: promotedAt - 120_000,
        exitReason: 'TP',
        pnlPct: 12,
        netPnlUsd: 30,
        grossPnlUsd: 30,
        grossPnlPct: 12,
        totalProceedsUsd: 280,
        grossTotalProceedsUsd: 280,
        age_hours: 0.5,
        effective_exit_price: 0.0033,
        theoretical_exit_price: 0.0033,
        exitMcUsd: 0.0033,
        costs: {} as ClosedTrade['costs'],
        lane: 'post_migration',
        source: 'raydium',
        metricType: 'price',
        dex: 'raydium',
        legs: [],
        partialSells: [],
        peak_pnl_pct: 15,
      },
    ];

    const open = new Map<string, OpenTrade>();
    const chainMap = new Map<string, bigint>([[DDPRHY_MINT, 0n]]);
    const paperCfg = loadPaperTraderConfig();

    const r = adoptCopyLeaderExitOpens({
      open,
      paperCfg,
      statePath,
      chainMap,
      closedTrades: closed,
    });

    expect(r.adopted).toEqual([]);
    expect(open.has(DDPRHY_MINT)).toBe(false);
    expect(readCopyLeaderMintAttribution(DDPRHY_MINT, statePath)).toBeNull();
  });

  it('skips adopt when wallet SPL is zero before Oscar close clears disk row', () => {
    const promotedAt = Date.now() - 60_000;
    const statePath = writeCopyState(DDPRHY_MINT, promotedAt);

    const skip = shouldSkipCopyLeaderExitAdopt({
      mint: DDPRHY_MINT,
      statePath,
      chainRaw: 0n,
    });
    expect(skip).toBe('wallet_spl_zero');
  });

  it('skips adopt when mint already closed after handoff promotion', () => {
    const promotedAt = Date.now() - 120_000;
    const statePath = writeCopyState(DDPRHY_MINT, promotedAt);

    const skip = shouldSkipCopyLeaderExitAdopt({
      mint: DDPRHY_MINT,
      statePath,
      chainRaw: 1000n,
      closedTrades: [
        {
          mint: DDPRHY_MINT,
          exitTs: promotedAt + 30_000,
        } as ClosedTrade,
      ],
    });
    expect(skip).toBe('oscar_already_closed');
  });
});
