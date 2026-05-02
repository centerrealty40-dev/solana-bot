import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import * as qnClient from '../src/core/rpc/qn-client.js';
import { loadLiveOscarConfig } from '../src/live/config.js';
import { reconcileLiveWalletVsReplay } from '../src/live/reconcile-live.js';
import type { OpenTrade } from '../src/papertrader/types.js';

describe('reconcileLiveWalletVsReplay (Phase 7)', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    vi.spyOn(qnClient, 'qnCall').mockReset();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  function mintOt(amountUsd: number, avg: number, dec = 6): OpenTrade {
    const ts = Date.now();
    const m = 'MintRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR';
    return {
      mint: m,
      symbol: 'T',
      lane: 'post_migration',
      metricType: 'price',
      dex: 'raydium',
      entryTs: ts,
      entryMcUsd: avg,
      entryMetrics: {
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
      peakMcUsd: avg,
      peakPnlPct: 0,
      trailingArmed: false,
      legs: [{ ts, price: avg, marketPrice: avg, sizeUsd: amountUsd, reason: 'open' }],
      partialSells: [],
      totalInvestedUsd: amountUsd,
      avgEntry: avg,
      avgEntryMarket: avg,
      remainingFraction: 1,
      dcaUsedLevels: new Set(),
      dcaUsedIndices: new Set(),
      ladderUsedLevels: new Set(),
      ladderUsedIndices: new Set(),
      pairAddress: null,
      entryLiqUsd: null,
      tokenDecimals: dec,
    };
  }

  it('returns ok when chain balances match expected atoms', async () => {
    process.env.LIVE_STRATEGY_ENABLED = '1';
    process.env.LIVE_EXECUTION_MODE = 'simulate';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    process.env.LIVE_WALLET_SECRET = JSON.stringify(Array.from(Keypair.generate().secretKey));

    const ot = mintOt(100, 1, 6);
    const expectedRaw = 100n * 1_000_000n;

    let rpcCall = 0;
    vi.spyOn(qnClient, 'qnCall').mockImplementation(async () => {
      rpcCall++;
      const row = [
        {
          account: {
            data: {
              parsed: {
                info: {
                  mint: ot.mint,
                  tokenAmount: { amount: expectedRaw.toString(), decimals: 6 },
                },
              },
            },
          },
        },
      ];
      // SPL + Token-2022: only first RPC returns balances so merge does not double-count.
      return { ok: true, value: rpcCall === 1 ? row : [] };
    });

    const liveCfg = loadLiveOscarConfig();
    const open = new Map([[ot.mint, ot]]);
    const rec = await reconcileLiveWalletVsReplay({
      liveCfg,
      open,
      toleranceAtoms: 1000n,
      mode: 'block_new',
    });
    expect(rec.ok).toBe(true);
    expect(rec.mismatches.length).toBe(0);
  });

  it('returns mismatch when balance differs beyond tolerance', async () => {
    process.env.LIVE_STRATEGY_ENABLED = '1';
    process.env.LIVE_EXECUTION_MODE = 'simulate';
    process.env.LIVE_STRATEGY_PROFILE = 'oscar';
    process.env.LIVE_TRADES_PATH = '/tmp/live-test.jsonl';
    process.env.LIVE_PARITY_PAPER_TRADES_PATH = '/tmp/paper-test.jsonl';
    process.env.LIVE_WALLET_SECRET = JSON.stringify(Array.from(Keypair.generate().secretKey));

    const ot = mintOt(100, 1, 6);

    let rpcCall2 = 0;
    vi.spyOn(qnClient, 'qnCall').mockImplementation(async () => {
      rpcCall2++;
      const row = [
        {
          account: {
            data: {
              parsed: {
                info: {
                  mint: ot.mint,
                  tokenAmount: { amount: '1', decimals: 6 },
                },
              },
            },
          },
        },
      ];
      return { ok: true, value: rpcCall2 === 1 ? row : [] };
    });

    const liveCfg = loadLiveOscarConfig();
    const open = new Map([[ot.mint, ot]]);
    const rec = await reconcileLiveWalletVsReplay({
      liveCfg,
      open,
      toleranceAtoms: 1000n,
      mode: 'report',
    });
    expect(rec.ok).toBe(false);
    expect(rec.mismatches.some((m) => m.mint === ot.mint)).toBe(true);
  });
});
