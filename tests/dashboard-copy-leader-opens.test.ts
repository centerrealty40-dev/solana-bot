import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveOscarPaper2Load } from '../scripts-tmp/dashboard-server.js';
import {
  loadCopyLeaderOpensForLiveOscarDashboard,
  mergeCopyLeaderOpensIntoLiveOscarLoad,
} from '../scripts-tmp/copytrader-dashboard.js';

const LEADER = '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma';
const SHARED_MINT = 'MintSharedOscarAndCopy1111111111111111111';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function emptyLiveLoad(openMint?: string): LiveOscarPaper2Load {
  const entryTs = Date.now() - 120_000;
  return {
    open: openMint
      ? [
          {
            mint: openMint,
            symbol: 'OSCAR',
            entryTs,
            entryMcUsd: 0.01,
            entryRealMcUsd: 5_000_000,
            baselinePriceUsd: 0.01,
            openedAtIso: new Date(entryTs).toISOString(),
            lane: 'prod',
            source: 'dexscreener',
            metricType: 'price',
            features: null,
            btc: null,
            peakMcUsd: 0.01,
            peakPnlPct: 0,
            trailingArmed: false,
            totalInvestedUsd: 2400,
            entryPriorityFeeUsd: null,
            entryPriceVerifySlipPct: null,
            entryPriceVerifyImpactPct: null,
            entryPriceVerifySource: null,
            pairAddress: null,
            entryLiqUsd: null,
            remainingFraction: 1,
            liveOscarTradeLane: 'prod',
            isScalpWave: false,
            isRunnerProbe: false,
          },
        ]
      : [],
    closed: [],
    firstTs: entryTs,
    lastTs: Date.now(),
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map(),
    hbOpen: openMint ? 1 : 0,
    hbClosed: 0,
  };
}

describe('copy-leader open rows on Live Oscar dashboard', () => {
  it('loads open positions from copytrader state with leader attribution', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-open-dash-'));
    const state = path.join(tmpDir, 'state.json');
    const journal = path.join(tmpDir, 'journal.jsonl');
    const entryTs = Date.now() - 300_000;
    fs.writeFileSync(
      state,
      JSON.stringify({
        positions: {
          [SHARED_MINT]: {
            mint: SHARED_MINT,
            symbol: 'COPYME',
            entryTs,
            entryPriceUsd: 0.002,
            sizeUsd: 500,
            entryDeployedCostUsd: 500,
            positionSource: 'copy_leader',
            leaderWallet: LEADER,
            addCount: 0,
            leaderEntrySig: 'LeaderBuy111111111111111111111111111111111111111111111111111111111111',
          },
        },
        pendingBuys: [],
        pendingSells: [],
      }),
      'utf8',
    );
    fs.writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: entryTs,
          kind: 'copy_buy',
          mode: 'live',
          mint: SHARED_MINT,
          symbol: 'COPYME',
          sizeUsd: 500,
          priceUsd: 0.002,
          ok: true,
          txSignature: 'sigBuy1111111111111111111111111111111111111111111111111111111111111111',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const merge = loadCopyLeaderOpensForLiveOscarDashboard(state, journal, LEADER);
    expect(merge?.open.length).toBe(1);
    expect(merge!.open[0]!.isCopyLeader).toBe(true);
    expect(merge!.open[0]!.totalInvestedUsd).toBe(500);
    expect(merge!.open[0]!.copyLeaderWalletShort).toBe('498S…aNma');
    expect(merge!.openTimelines.get(SHARED_MINT)?.length).toBeGreaterThan(0);
  });

  it('keeps Oscar and copy rows separate on the same mint', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-open-dash-'));
    const state = path.join(tmpDir, 'state.json');
    const journal = path.join(tmpDir, 'journal.jsonl');
    fs.writeFileSync(
      state,
      JSON.stringify({
        positions: {
          [SHARED_MINT]: {
            mint: SHARED_MINT,
            symbol: 'BOTH',
            entryTs: Date.now() - 60_000,
            entryPriceUsd: 0.003,
            sizeUsd: 500,
            entryDeployedCostUsd: 500,
            positionSource: 'copy_leader',
            leaderWallet: LEADER,
            addCount: 0,
            leaderEntrySig: 'x',
          },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(journal, '', 'utf8');

    const live = emptyLiveLoad(SHARED_MINT);
    const merge = loadCopyLeaderOpensForLiveOscarDashboard(state, journal, LEADER)!;
    const merged = mergeCopyLeaderOpensIntoLiveOscarLoad(live, merge);

    expect(merged.open.length).toBe(2);
    expect(merged.open.filter((o) => o.isCopyLeader).length).toBe(1);
    expect(merged.open.filter((o) => !o.isCopyLeader).length).toBe(1);
    expect(merged.openTimelines.has(`copy:${SHARED_MINT}`)).toBe(true);
  });

  it('mergeCopyLeaderOpensIntoLiveOscarLoad stores copy timelines under copy:mint key', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-open-dash-'));
    const state = path.join(tmpDir, 'state.json');
    const journal = path.join(tmpDir, 'journal.jsonl');
    const mint = 'MintOnlyCopy111111111111111111111111111111';
    fs.writeFileSync(
      state,
      JSON.stringify({
        positions: {
          [mint]: {
            mint,
            symbol: 'ONLY',
            entryTs: Date.now() - 30_000,
            entryPriceUsd: 0.001,
            sizeUsd: 500,
            entryDeployedCostUsd: 500,
            positionSource: 'copy_leader',
            leaderWallet: LEADER,
            addCount: 0,
            leaderEntrySig: 'y',
          },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(journal, '', 'utf8');

    const merge = loadCopyLeaderOpensForLiveOscarDashboard(state, journal, LEADER)!;
    const merged = mergeCopyLeaderOpensIntoLiveOscarLoad(emptyLiveLoad(), merge);
    expect(merged.openTimelines.get(`copy:${mint}`)?.length).toBeGreaterThan(0);
    expect(merge.copyTrader).toBeDefined();
  });
});
