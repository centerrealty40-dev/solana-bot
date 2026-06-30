import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  oscarWalletMintUsdExcludingCopyLeader,
  readCopyLeaderCostBasisUsd,
} from '../../src/live/copy-leader-attribution.js';

describe('copy-leader-attribution', () => {
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

  function writeState(positions: Record<string, unknown>): string {
    const fp = path.join(os.tmpdir(), `copy-state-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(fp, JSON.stringify({ positions }), 'utf8');
    tmpFiles.push(fp);
    return fp;
  }

  it('subtracts copy cost basis from wallet mint USD for oscar gate', () => {
    const mint = 'MintCopyLeaderAttribution1111111111111111111';
    const statePath = writeState({
      [mint]: {
        sizeUsd: 500,
        entryDeployedCostUsd: 500,
        positionSource: 'copy_leader',
      },
    });

    const net = oscarWalletMintUsdExcludingCopyLeader({
      walletMintUsd: 520,
      mint,
      statePath,
    });
    expect(net).toBe(20);
    expect(readCopyLeaderCostBasisUsd(mint, statePath)).toBe(500);
  });

  it('returns gross when no copy position', () => {
    const mint = 'MintNoCopy1111111111111111111111111111111';
    const statePath = writeState({});
    expect(
      oscarWalletMintUsdExcludingCopyLeader({ walletMintUsd: 2400, mint, statePath }),
    ).toBe(2400);
  });
});
