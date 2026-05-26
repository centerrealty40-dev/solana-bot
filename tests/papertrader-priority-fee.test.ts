import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/core/rpc/qn-client.js', () => ({
  qnCall: vi.fn(),
}));

import { qnCall } from '../src/core/rpc/qn-client.js';
import {
  startPriorityFeeTicker,
  stopPriorityFeeTicker,
  getPriorityFeeUsd,
  _resetPriorityFeeStateForTests,
} from '../src/papertrader/pricing/priority-fee.js';

const baseCfg = {
  priorityFeeEnabled: true,
  priorityFeeTickerMs: 60_000,
  priorityFeeMaxAgeMs: 600_000,
  priorityFeeRpcTimeoutMs: 2500,
  priorityFeePercentile: 'p75' as const,
  priorityFeeTargetCu: 200_000,
  networkFeeUsd: 0.05,
} as const;

beforeEach(() => {
  vi.mocked(qnCall).mockReset();
  _resetPriorityFeeStateForTests();
  // Avoid reading repo workspace data/priority-fee-cache.json (would look like "live").
  process.env.PAPER_PRIORITY_FEE_CACHE_PATH = path.join(
    os.tmpdir(),
    `vitest-priority-fee-no-cache-${process.pid}-${Date.now()}.json`,
  );
});

describe('priority-fee monitor', () => {
  it('returns fallback when ticker disabled', () => {
    const q = getPriorityFeeUsd({ ...baseCfg, priorityFeeEnabled: false }, 160);
    expect(q.source).toBe('fallback');
    expect(q.usd).toBe(0.05);
  });

  it('returns fallback when cache empty', () => {
    const q = getPriorityFeeUsd(baseCfg as never, 160);
    expect(q.source).toBe('fallback');
  });

  it('computes p75 USD when ticker filled the cache', async () => {
    const fees = Array.from({ length: 100 }, (_, i) => ({ slot: i + 1, prioritizationFee: i + 1 }));
    vi.mocked(qnCall).mockResolvedValueOnce({ ok: true, value: fees });
    startPriorityFeeTicker(baseCfg as never);
    await new Promise((r) => setTimeout(r, 30));
    stopPriorityFeeTicker();
    const q = getPriorityFeeUsd(baseCfg as never, 160);
    expect(q.source).toBe('live');
    expect(q.microLamportsPerCu).toBe(75);
    expect(q.usd).toBeGreaterThan(0);
  });

  it('falls back when observation older than maxAge', async () => {
    const fees = [{ slot: 1, prioritizationFee: 1000 }];
    vi.mocked(qnCall).mockResolvedValueOnce({ ok: true, value: fees });
    startPriorityFeeTicker({ ...baseCfg, priorityFeeMaxAgeMs: 1 } as never);
    await new Promise((r) => setTimeout(r, 50));
    stopPriorityFeeTicker();
    const q = getPriorityFeeUsd({ ...baseCfg, priorityFeeMaxAgeMs: 1 } as never, 160);
    expect(q.source).toBe('fallback');
  });
});
