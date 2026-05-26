import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('solana-rpc-meter hourly cap', () => {
  let dir: string;
  let usageFile: string;

  beforeEach(() => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-meter-hour-'));
    usageFile = path.join(dir, 'usage.json');
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/test';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.QUICKNODE_USAGE_PATH = usageFile;
    process.env.QUICKNODE_DAILY_ENFORCE = '0';
    process.env.QUICKNODE_HOURLY_CREDIT_BUDGET = '100';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.QUICKNODE_USAGE_PATH;
    delete process.env.QUICKNODE_DAILY_ENFORCE;
    delete process.env.QUICKNODE_HOURLY_CREDIT_BUDGET;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('blocks when hour bucket would exceed hourly cap', async () => {
    const {
      reserveSolanaRpcCredits,
      releaseSolanaRpcCredits,
      solanaRpcMeterCounters,
    } = await import('../src/core/rpc/solana-rpc-meter.js');
    expect(await reserveSolanaRpcCredits(50)).toBe(true);
    expect(solanaRpcMeterCounters().hourCredits).toBe(50);
    expect(await reserveSolanaRpcCredits(60)).toBe(false);
    await releaseSolanaRpcCredits(50);
    expect(await reserveSolanaRpcCredits(60)).toBe(true);
  });
});
