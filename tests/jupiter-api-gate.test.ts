import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  acquireJupiterApiSlot,
  acquireJupiterApiSlotWithPriority,
  extendJupiterApiPause,
  noteJupiterRateLimitHeaders,
  resetJupiterApiGateForTests,
} from '../src/core/jupiter-api-gate.js';

describe('jupiter-api-gate', () => {
  const envBackup = { ...process.env };
  let gateDir = '';

  beforeEach(() => {
    process.env = { ...envBackup };
    gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jup-gate-'));
    process.env.JUPITER_GLOBAL_RATE_LIMIT = '1';
    process.env.JUPITER_GLOBAL_MAX_RPS = '10';
    process.env.JUPITER_GLOBAL_GATE_PATH = path.join(gateDir, 'gate.json');
    resetJupiterApiGateForTests();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    resetJupiterApiGateForTests();
    try {
      fs.rmSync(gateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('serializes slots so two acquires are at least minGap apart', async () => {
    const t0 = Date.now();
    await acquireJupiterApiSlot();
    await acquireJupiterApiSlot();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('disabled when JUPITER_GLOBAL_RATE_LIMIT=0', async () => {
    process.env.JUPITER_GLOBAL_RATE_LIMIT = '0';
    const t0 = Date.now();
    await Promise.all([acquireJupiterApiSlot(), acquireJupiterApiSlot()]);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('waits for org-wide 429 pause before granting slot', async () => {
    const pauseUntil = Date.now() + 120;
    extendJupiterApiPause(pauseUntil);
    const t0 = Date.now();
    await acquireJupiterApiSlot();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });

  it('refuses background slots during pause and when spacing is active', async () => {
    process.env.JUPITER_GLOBAL_BACKGROUND_MAX_RPS = '1';
    extendJupiterApiPause(Date.now() + 120);
    expect(await acquireJupiterApiSlotWithPriority('background')).toBe(false);
    resetJupiterApiGateForTests();
    expect(await acquireJupiterApiSlotWithPriority('background')).toBe(true);
    expect(await acquireJupiterApiSlotWithPriority('background')).toBe(false);
  });

  it('refuses background slots when the projected execution wait is too long', async () => {
    process.env.JUPITER_BACKGROUND_MAX_WAIT_MS = '10';
    await acquireJupiterApiSlot();
    expect(await acquireJupiterApiSlotWithPriority('background')).toBe(false);
  });

  it('execution waits for the window reset once x-ratelimit-remaining hits 0', async () => {
    const resetMs = Date.now() + 150;
    noteJupiterRateLimitHeaders(
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetMs / 1000),
      }),
    );
    const t0 = Date.now();
    await acquireJupiterApiSlot();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it('background is refused while the window budget is within the execution reserve', async () => {
    process.env.JUPITER_BACKGROUND_RESERVE = '3';
    process.env.JUPITER_GLOBAL_BACKGROUND_MAX_RPS = '20';
    process.env.JUPITER_BACKGROUND_MAX_WAIT_MS = '5000';
    noteJupiterRateLimitHeaders(
      new Headers({
        'x-ratelimit-remaining': '4',
        'x-ratelimit-reset': String((Date.now() + 5_000) / 1000),
      }),
    );
    expect(await acquireJupiterApiSlotWithPriority('background')).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(await acquireJupiterApiSlotWithPriority('background')).toBe(false);
  });

  it('ignores the header budget when JUPITER_GATE_HEADER_BUDGET=0', async () => {
    process.env.JUPITER_GATE_HEADER_BUDGET = '0';
    noteJupiterRateLimitHeaders(
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String((Date.now() + 5_000) / 1000),
      }),
    );
    const t0 = Date.now();
    await acquireJupiterApiSlot();
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('always grants execution through the priority API', async () => {
    process.env.JUPITER_GLOBAL_BACKGROUND_MAX_RPS = '1';
    expect(await acquireJupiterApiSlotWithPriority('execution')).toBe(true);
  });
});
