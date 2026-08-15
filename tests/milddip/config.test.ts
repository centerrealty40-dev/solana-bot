import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadMildDipConfig } from '../../src/milddip/config.js';

function withConfigEnv<T>(env: Record<string, string>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function loaderExitKeys(): string[] {
  const source = readFileSync(new URL('../../src/milddip/config.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const exit: MildDipExitGates = {');
  const end = source.indexOf('\n  const raw = {', start);
  if (start < 0 || end < 0) throw new Error('unable to locate mild-dip exit loader');
  return [...source.slice(start, end).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map(
    (match) => match[1],
  );
}

describe('mild-dip config exit schema', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('preserves every key assigned by the exit loader', () => {
    const cfg = withConfigEnv(baseEnv, () => loadMildDipConfig());
    const dropped = loaderExitKeys().filter((key) => !(key in cfg.exit));
    expect(dropped, `exit loader keys dropped by schema: ${dropped.join(', ')}`).toEqual([]);
  });

  it('loads the green sleeve partial fraction from the environment', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_MFE_BANK_SLEEVE_GREEN_PARTIAL_FRACTION: '0.5',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.mfeBankSleeveGreenPartialFraction).toBe(0.5);
  });

  it('loads the sleeve runner giveback width from the environment', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_SLEEVE_RUNNER_GIVEBACK_PCT: '25',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.mfeBankSleeveRunnerGivebackPct).toBe(25);
  });
});
