import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.879 — two `never_arm_bounce` legs went out 4.1s apart on one bag
 * (33Grh5V then 2HJmyTW). `sellInFlight` had already cleared, so the next mark
 * tick decided again on a price that predated the first sell and a size the
 * chain read had not caught up with; the second leg filled 5.6% lower.
 */
describe('exit spacing after a sell', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('holds further exit decisions on a bag that just sold', () => {
    expect(loop).toContain('cfg.exitMinSpacingMs > 0 &&');
    expect(loop).toContain('pos.lastSellAtMs != null &&');
    expect(loop).toContain('nowMs - pos.lastSellAtMs < cfg.exitMinSpacingMs');
  });

  it('stamps the sell time so the window starts when the size could change', () => {
    expect(loop).toContain('if (after) after.lastSellAtMs = Date.now();');
  });

  it('the guard sits alongside sellInFlight, not instead of it', () => {
    // In-flight dedupe covers the transaction; the window covers the settle.
    expect(loop).toContain('if (!pos || sellInFlight.has(mint)) continue;');
  });

  it('defaults to a window several mark cycles wide', () => {
    // Marks run at 2000ms live, so 10s is five readings after the sell.
    const config = readFileSync(resolve('src/milddip/config.ts'), 'utf8');
    expect(config).toContain(
      'exitMinSpacingMs: z.coerce.number().int().min(0).max(600_000).default(10_000)',
    );
    expect(config).toContain("process.env.MILD_DIP_EXIT_MIN_SPACING_MS ?? 10_000");
  });
});
