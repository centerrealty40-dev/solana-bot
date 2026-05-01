import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/db/client.js', () => ({
  db: { execute: vi.fn() },
}));

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

import { db } from '../src/core/db/client.js';
import { fetch } from 'undici';
import { fetchLatestSnapshotMcap, getLiveMcUsd } from '../src/papertrader/pricing.js';

const mockExec = vi.mocked(db.execute);
const mockFetch = vi.mocked(fetch);

beforeEach(() => {
  mockExec.mockReset();
  mockFetch.mockReset();
});

describe('fetchLatestSnapshotMcap', () => {
  it('prefers market_cap_usd over fdv', async () => {
    mockExec.mockResolvedValueOnce([{ market_cap_usd: 800_000, fdv_usd: 1_500_000 }] as never);
    const mc = await fetchLatestSnapshotMcap('mint', 'raydium');
    expect(mc).toBe(800_000);
  });
  it('falls back to fdv when mcap is null', async () => {
    mockExec.mockResolvedValueOnce([{ market_cap_usd: null, fdv_usd: 1_200_000 }] as never);
    const mc = await fetchLatestSnapshotMcap('mint', 'raydium');
    expect(mc).toBe(1_200_000);
  });
  it('returns null when both empty', async () => {
    mockExec.mockResolvedValueOnce([{ market_cap_usd: 0, fdv_usd: 0 }] as never);
    const mc = await fetchLatestSnapshotMcap('mint', 'raydium');
    expect(mc).toBeNull();
  });
});

describe('getLiveMcUsd cache', () => {
  it('cache hit avoids second db query', async () => {
    mockExec.mockResolvedValueOnce([{ market_cap_usd: 770_100, fdv_usd: null }] as never);
    const a = await getLiveMcUsd('mint-cache', 'raydium');
    const b = await getLiveMcUsd('mint-cache', 'raydium');
    expect(a).toBe(770_100);
    expect(b).toBe(770_100);
    expect(mockExec.mock.calls.length).toBe(1);
  });
});
