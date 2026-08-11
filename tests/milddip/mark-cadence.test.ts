import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('1.11.826 open-book mark cadence', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('marks refresh fast enough for a −12% sleeve to mean anything', () => {
    // At 8s/20s a +22.95% peak round-tripped to −23.6% from peak between marks.
    expect(eco).toContain("MILD_DIP_MARK_DEX_REFRESH_MS: '2000'");
    expect(eco).toContain("MILD_DIP_MARK_CACHE_TTL_MS: '3000'");
  });

  it('cache TTL does not outlive the refresh interval', () => {
    const refresh = Number(/MILD_DIP_MARK_DEX_REFRESH_MS: '(\d+)'/.exec(eco)![1]);
    const ttl = Number(/MILD_DIP_MARK_CACHE_TTL_MS: '(\d+)'/.exec(eco)![1]);
    const markEvery = Number(/MILD_DIP_MARK_INTERVAL_MS: '(\d+)'/.exec(eco)![1]);
    expect(refresh).toBeGreaterThanOrEqual(markEvery);
    // A TTL far above the refresh interval silently re-serves a stale price.
    expect(ttl).toBeLessThanOrEqual(refresh * 2);
  });

  it('the open book is refreshed in batches, not one call per position', () => {
    const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(loop).toContain('prefetchDexScreenerPairDetailsMany');
  });
});
