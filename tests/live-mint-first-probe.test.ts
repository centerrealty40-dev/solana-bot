import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  clearLiveMintGraduatedCacheForTests,
  isMintLiveOscarGraduated,
  markMintLiveOscarGraduated,
  onLiveOscarFirstMintProbeFullClose,
  shouldUseLiveMintFirstProbe,
} from '../src/live/mint-first-probe.js';
import {
  clearLivePermanentDenylistCacheForTests,
  loadPermanentDenylistCombined,
} from '../src/live/mint-permanent-denylist.js';
import { buildLiveStagedEntryState, stagedAveragingConfigured } from '../src/papertrader/executor/live-staged-entry-gates.js';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-first-probe-'));
}

function liveCfg(dir: string): LiveOscarConfig {
  return {
    executionMode: 'live',
    liveMintFirstProbeEnabled: true,
    liveFirstMintProbeDenyOnLossEnabled: true,
    liveMintFirstProbeKillDropPct: 7,
    liveMintGraduatedPath: path.join(dir, 'graduated.txt'),
    livePermanentDenylistDisabled: false,
    livePermanentDenylistLocalPath: path.join(dir, 'deny.txt'),
    livePermanentDenylistSeedPath: path.join(dir, 'deny-seed.txt'),
  } as LiveOscarConfig;
}

describe('live mint first probe', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    clearLiveMintGraduatedCacheForTests();
    clearLivePermanentDenylistCacheForTests();
  });

  it('buildLiveStagedEntryState disables averaging and sets kill 7%', () => {
    const cfg = loadPaperTraderConfig({ strategyId: 'live-oscar' });
    const st = buildLiveStagedEntryState(
      cfg,
      { signalTs: Date.now(), signalPriceUsd: 1 },
      { firstMintProbe: true, firstMintKillDropPct: 7 },
    );
    expect(st.killDropPct).toBe(7);
    expect(st.mintFirstProbe).toBe(true);
    expect(stagedAveragingConfigured(st)).toBe(false);
    expect(st.secondLegUsd).toBe(0);
  });

  it('graduates mint after profitable first-probe close', () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'deny-seed.txt'), '# empty\n', 'utf8');
    const cfg = liveCfg(dir);
    const mint = 'MintGrad111111111111111111111111111111111111';

    onLiveOscarFirstMintProbeFullClose({
      liveOscarCfg: cfg,
      strategyId: 'live-oscar',
      mint,
      symbol: 'OK',
      netPnlUsd: 42,
      liveMintFirstProbe: true,
    });

    expect(isMintLiveOscarGraduated(cfg, mint)).toBe(true);
    expect(shouldUseLiveMintFirstProbe(cfg, mint)).toBe(false);
  });

  it('denylists mint on first-probe loss', () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'deny-seed.txt'), '# empty\n', 'utf8');
    const cfg = liveCfg(dir);
    const mint = 'MintLoss111111111111111111111111111111111111';

    onLiveOscarFirstMintProbeFullClose({
      liveOscarCfg: cfg,
      strategyId: 'live-oscar',
      mint,
      symbol: 'BAD',
      netPnlUsd: -70,
      liveMintFirstProbe: true,
      killDropPct: 7,
    });

    const set = loadPermanentDenylistCombined(cfg);
    expect(set.has(mint)).toBe(true);
    expect(isMintLiveOscarGraduated(cfg, mint)).toBe(false);
  });

  it('markMintLiveOscarGraduated is idempotent', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const cfg = liveCfg(dir);
    const mint = 'MintIdem111111111111111111111111111111111111';
    expect(markMintLiveOscarGraduated(cfg, mint)).toBe(true);
    expect(markMintLiveOscarGraduated(cfg, mint)).toBe(false);
  });
});

