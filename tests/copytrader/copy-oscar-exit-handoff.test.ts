import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoffCopyPositionToOscarExit } from '../../src/copytrader/copy-oscar-exit-handoff.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import type { CopyPosition, CopyTraderState } from '../../src/copytrader/state.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';
import { adoptCopyLeaderExitOpens } from '../../src/live/copy-leader-exit-adopt.js';
import type { OpenTrade } from '../../src/papertrader/types.js';
import { loadPaperTraderConfig } from '../../src/papertrader/config.js';

const cfgBase: CopyTraderConfig = {
  targetWallet: '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma',
  rpcUrl: 'https://example.com',
  executionMode: 'paper',
  journalPath: 'data/copytrader/journal-test.jsonl',
  statePath: 'data/copytrader/state-test.json',
  pollIntervalMs: 5000,
  signatureLimit: 25,
  tickIntervalMs: 2000,
  buyDelayMs: 5000,
  entryProbeBuyDelayMs: 0,
  buyRetryWindowMs: 7_200_000,
  buyRetryDeferLogMs: 60_000,
  sellRetryWindowMs: 7_200_000,
  sellRetryIntervalMs: 3_000,
  sellRetryDeferLogMs: 30_000,
  minSellIntervalMs: 0,
  entryDipJupiterMinIntervalMs: 0,
  sellDelayMinMs: 0,
  sellDelayMaxMs: 2000,
  leaderFlatConfirmDelayMs: 3000,
  leaderFlatDustRaw: 10_000n,
  positionUsd: 500,
  initialMirrorRatio: 0.5,
  addPositionUsd: 500,
  maxPositionUsd: 0,
  maxAddsPerMint: 0,
  minProportionalAddUsd: 0,
  minProportionalSellFraction: 0,
  buyPriceMaxPremiumPct: 3,
  entryFullMcapUsd: 1_000_000,
  entryMidPositionUsd: 600,
  entryMidLegUsd: 300,
  entryProbeFraction: 1,
  entryDipDiscountPct: 0,
  entryDipConfirmTicks: 2,
  entryDipVsProbePct: 2,
  entryMinDeployFraction: 0.99,
  addPriceMaxPremiumPct: 0,
  allowLateEntryOnLeaderRebuy: true,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
  maxOpenPositions: 0,
  slippageBps: 100,
  sharedOscarWallet: true,
  exitMode: 'oscar_half8',
  spareCapitalGateEnabled: false,
};

describe('copy oscar exit handoff', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  it('marks oscarPromotedAt on handoff', () => {
    const statePath = path.join(os.tmpdir(), `ct-handoff-${Date.now()}.json`);
    tmpFiles.push(statePath);
    fs.writeFileSync(statePath, JSON.stringify({ positions: {} }), 'utf8');

    const state: CopyTraderState = emptyCopyTraderState();
    const pos: CopyPosition = {
      mint: 'MintCopyExit111111111111111111111111111111',
      symbol: 'COPY',
      entryTs: Date.now(),
      entryPriceUsd: 0.01,
      sizeUsd: 250,
      entryDeployedCostUsd: 250,
      addCount: 0,
      leaderWallet: cfgBase.targetWallet,
      leaderEntrySig: 'sig',
    };
    state.positions[pos.mint] = pos;

    const cfg = { ...cfgBase, statePath, journalPath: path.join(os.tmpdir(), `j-${Date.now()}.jsonl`) };
    tmpFiles.push(cfg.journalPath);

    expect(handoffCopyPositionToOscarExit({ cfg, state, pos })).toBe(true);
    expect(pos.oscarPromotedAt).toBeGreaterThan(0);
  });

  it('adopts promoted copy position into live-oscar open map', async () => {
    const mint = 'MintAdoptCopy11111111111111111111111111111';
    const statePath = path.join(os.tmpdir(), `ct-adopt-${Date.now()}.json`);
    tmpFiles.push(statePath);
    const promotedAt = Date.now() - 60_000;
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        positions: {
          [mint]: {
            mint,
            symbol: 'ADOPT',
            entryTs: promotedAt,
            entryPriceUsd: 0.002,
            entryMcapUsd: 5_000_000,
            sizeUsd: 250,
            entryDeployedCostUsd: 250,
            positionSource: 'copy_leader',
            oscarPromotedAt: promotedAt,
            ourEntrySig: 'BuySig111111111111111111111111111111111111111111111111111111111111',
          },
        },
      }),
      'utf8',
    );

    const open = new Map<string, OpenTrade>();
    const journal: Record<string, unknown>[] = [];
    const paperCfg = loadPaperTraderConfig();

    const r = await adoptCopyLeaderExitOpens({
      open,
      paperCfg,
      statePath,
      resolveMcapUsd: async () => 5_000_000,
      journalLiveStrategy: (body) => journal.push(body),
    });

    expect(r.adopted).toEqual([mint]);
    expect(open.has(mint)).toBe(true);
    const ot = open.get(mint)!;
    expect(ot.liveExitPolicyId).toBe('wave_b_v1');
    expect(ot.liveWaveFlatTpMode).toBe('half8_runner');
    expect(ot.copyToOscarPromoted).toBe(true);
    expect(journal.some((j) => j.kind === 'live_position_open')).toBe(true);
  });
});
