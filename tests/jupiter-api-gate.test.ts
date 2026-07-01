import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  acquireJupiterApiSlot,
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
});
