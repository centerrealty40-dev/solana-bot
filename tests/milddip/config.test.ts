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

  it('loads the armed-runner bounce flag from the environment', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_NEVER_ARM_BOUNCE_ARMED_RUNNER: '0',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.neverArmBounceArmedRunner).toBe(false);
  });

  it('loads the first TP rung and profit fill guard from the environment', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_TP_GRID_FIRST_RUNG_PCT: '20',
        MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '4',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.tpGridFirstRungPct).toBe(20);
    expect(cfg.exit.profitFillMaxSlipPct).toBe(4);
  });

  it('keeps the production first rung and profit guard values', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_FIRST_RUNG_PCT: '20'");
    expect(eco).toContain("MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '4'");
  });

  it('loads quarantine refresh and green blind-window settings', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MARK_QUARANTINE_JUPITER_GAP_MS: '2000',
        MILD_DIP_EXIT_MARK_QUARANTINE_GREEN_MAX_MS: '10000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.markQuarantineJupiterGapMs).toBe(2000);
    expect(cfg.exit.markQuarantineGreenMaxMs).toBe(10000);
  });

  it('keeps production quarantine settings', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_MARK_QUARANTINE_JUPITER_GAP_MS: '2000'");
    expect(eco).toContain("MILD_DIP_EXIT_MARK_QUARANTINE_GREEN_MAX_MS: '10000'");
  });
});
