import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.836 — the green sampler exists to supply matched negatives, and it must do
 * that without touching the bot's DexScreener share. Measured on the host: a
 * single-mint DexScreener probe returns 429 three times in a row while the bot
 * paces itself to 10 marks/min, so the budget has no slack.
 */
describe('leader green observer', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const py = readFileSync(resolve('scripts/milddip/leader-green-observer.py'), 'utf8');

  function greenEnv(key: string): string | null {
    const block = eco.slice(eco.indexOf("name: 'mild-dip-leader-green'"));
    const m = block.match(new RegExp(`${key}: '([^']*)'`));
    return m ? m[1] : null;
  }

  it('runs as its own PM2 app', () => {
    expect(eco).toContain("name: 'mild-dip-leader-green'");
    expect(eco).toContain("args: 'scripts/milddip/leader-green-observer.py'");
  });

  it('keeps its DexScreener share to a few requests a minute', () => {
    const cap = Number(greenEnv('LEADER_GREEN_MAX_DEX_REQ_PER_MIN'));
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(5);
  });

  it('prices from Jupiter, not DexScreener', () => {
    expect(py).toContain('JUPITER_URL = "https://api.jup.ag/price/v3"');
    expect(py).toContain('"priceSource": "jupiter"');
  });

  it('paces Jupiter batches for the 1 RPS free tier', () => {
    expect(py).toContain('_jup_min_gap_ms');
    const universe = Number(greenEnv('LEADER_GREEN_MAX_UNIVERSE'));
    const sampleSec = Number(greenEnv('LEADER_GREEN_SAMPLE_SEC'));
    // Batches of 40 at ~1.1s apart must fit inside one cycle.
    expect(Math.ceil(universe / 40) * 1.1).toBeLessThan(sampleSec);
  });

  it('records the boundary, not only green rows', () => {
    expect(Number(greenEnv('LEADER_GREEN_MIN_PC5M'))).toBeLessThanOrEqual(0);
  });

  it('emits momentum windows the single-snapshot corpus lacked', () => {
    for (const key of ['"ret30s"', '"ret1m"', '"ret3m"', '"ret5m"']) {
      expect(py).toContain(key);
    }
  });

  it('writes no labels and never polls RPC — labelling is an offline join', () => {
    expect(py).toContain('leader_green_sample');
    // No chain reads: the sampler must not be able to fall behind its cadence.
    expect(py).not.toContain('getTransaction');
    expect(py).not.toContain('getSignaturesForAddress');
    // Every emitted record stays in its own namespace.
    const kinds = [...py.matchAll(/"kind": "([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k.startsWith('leader_green_'))).toBe(true);
  });

  it('skips a cycle rather than crowding the bot out', () => {
    expect(py).toContain('def dex_budget');
    expect(py).toContain('if not stale or not self.dex_budget(1):');
  });
});
