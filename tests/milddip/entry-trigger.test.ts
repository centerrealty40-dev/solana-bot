import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeCopyBuy } from '../../src/copytrader/executor.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';

function paperConfig(journalPath: string): CopyTraderConfig {
  return {
    executionMode: 'paper',
    journalPath,
  } as CopyTraderConfig;
}

function readEvents(journalPath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('mild-dip trigger journaling', () => {
  it('writes trigger on successful copy-buy events and tolerates a missing trigger', async () => {
    const journalPath = path.join(os.tmpdir(), `milddip-trigger-${Date.now()}.jsonl`);
    try {
      await executeCopyBuy({
        cfg: paperConfig(journalPath),
        mint: 'mint-with-trigger',
        symbol: 'WITH',
        priceUsd: 1,
        sizeUsd: 1,
        kind: 'entry',
        evalResult: { pass: true, reasons: [], score: 0 },
        leaderSignature: 'local-with-trigger',
        trigger: 'leader',
      });
      await executeCopyBuy({
        cfg: paperConfig(journalPath),
        mint: 'mint-without-trigger',
        symbol: 'WITHOUT',
        priceUsd: 1,
        sizeUsd: 1,
        kind: 'entry',
        evalResult: { pass: true, reasons: [], score: 0 },
        leaderSignature: 'local-without-trigger',
      });

      const events = readEvents(journalPath);
      expect(events).toHaveLength(2);
      expect(events[0]?.trigger).toBe('leader');
      expect(events[1]).not.toHaveProperty('trigger');
    } finally {
      fs.rmSync(journalPath, { force: true });
    }
  });
});
