import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLivePermanentDenylistCacheForTests,
  isMintPermanentlyDeniedLiveOscar,
  loadPermanentDenylistCombined,
} from '../src/live/mint-permanent-denylist.js';
import { onLiveOscarFullCloseNegativeTradeDenylist } from '../src/live/mint-whitelist.js';
import type { LiveOscarConfig } from '../src/live/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-deny-'));
}

describe('live negative trade denylist', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    clearLivePermanentDenylistCacheForTests();
  });

  it('appends mint to local denylist on negative close', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const localPath = path.join(dir, 'deny-local.txt');
    const seedPath = path.join(dir, 'deny-seed.txt');
    fs.writeFileSync(seedPath, '# empty\n', 'utf8');

    const cfg = {
      livePermanentDenylistDisabled: false,
      livePermanentDenylistLocalPath: localPath,
      livePermanentDenylistSeedPath: seedPath,
      executionMode: 'live',
    } as LiveOscarConfig;

    onLiveOscarFullCloseNegativeTradeDenylist({
      liveOscarCfg: cfg,
      strategyId: 'live-oscar',
      mint: 'MintNeg1111111111111111111111111111111111111',
      symbol: 'NEG',
      netPnlUsd: -12.5,
    });

    const set = loadPermanentDenylistCombined(cfg);
    expect(set.has('MintNeg1111111111111111111111111111111111111')).toBe(true);
    expect(isMintPermanentlyDeniedLiveOscar(cfg, 'MintNeg1111111111111111111111111111111111111')).toBe(
      true,
    );

    onLiveOscarFullCloseNegativeTradeDenylist({
      liveOscarCfg: cfg,
      strategyId: 'live-oscar',
      mint: 'MintNeg1111111111111111111111111111111111111',
      symbol: 'NEG',
      netPnlUsd: -5,
    });
    expect(fs.readFileSync(localPath, 'utf8').match(/MintNeg/g)?.length).toBe(1);
  });

  it('ignores profitable close', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const localPath = path.join(dir, 'deny-local.txt');
    const seedPath = path.join(dir, 'deny-seed.txt');
    fs.writeFileSync(localPath, '', 'utf8');
    fs.writeFileSync(seedPath, '', 'utf8');

    const cfg = {
      livePermanentDenylistDisabled: false,
      livePermanentDenylistLocalPath: localPath,
      livePermanentDenylistSeedPath: seedPath,
      executionMode: 'live',
    } as LiveOscarConfig;

    onLiveOscarFullCloseNegativeTradeDenylist({
      liveOscarCfg: cfg,
      strategyId: 'live-oscar',
      mint: 'MintWin1111111111111111111111111111111111111',
      symbol: 'WIN',
      netPnlUsd: 42,
    });

    expect(loadPermanentDenylistCombined(cfg).size).toBe(0);
  });
});
