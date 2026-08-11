import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.837 — coverage was never the bottleneck. Of 235 mints the leaders bought in
 * a 12h window, 221 (94%) appear in our own journal; 11 of the 14 we missed are
 * non-pump mints. What blocks entries is data: `structural_fetch_null` is 27% of
 * every fast-path skip (25_222 of 93_529), because DexScreener rate limits this
 * host and the stale-reuse ceiling was 30s for fields that move far slower.
 */
describe('structural stale reuse', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const fp = readFileSync(resolve('src/milddip/fast-path.ts'), 'utf8');
  const cfgSrc = readFileSync(resolve('src/milddip/config.ts'), 'utf8');

  it('defaults to the previous 30s so the knob is opt-in', () => {
    expect(cfgSrc).toContain(
      'fastPathStructuralStaleMs: z.coerce.number().int().min(0).max(600_000).default(30_000)',
    );
    expect(cfgSrc).toContain(
      "process.env.MILD_DIP_FAST_PATH_STRUCTURAL_STALE_MS ?? 30_000",
    );
  });

  it('reads the window from config instead of a hard constant', () => {
    expect(fp).toContain('cfg.fastPathStructuralStaleMs > 0');
    expect(fp).toContain('getStructuralCache(mint, nowMs, staleMs)');
  });

  it('live env widens it to 120s', () => {
    expect(eco).toContain("MILD_DIP_FAST_PATH_STRUCTURAL_STALE_MS: '120000'");
  });

  it('is schema-capped at ten minutes so it cannot be widened without limit', () => {
    expect(cfgSrc).toContain('.max(600_000).default(30_000)');
    const live = Number(
      eco.match(/MILD_DIP_FAST_PATH_STRUCTURAL_STALE_MS: '(\d+)'/)?.[1] ?? '0',
    );
    expect(live).toBeGreaterThan(30_000);
    expect(live).toBeLessThanOrEqual(600_000);
  });

  it('journals the snapshot age so stale entries stay auditable', () => {
    expect(fp).toContain('const structAgeMs = Math.max(0, nowMs - struct.fetchedAtMs);');
    expect(fp).toContain('structAgeMs,');
  });
});
