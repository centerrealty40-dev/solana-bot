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

  it('defaults cross-leader averaging off and loads its settings', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.leaderMirror.crossLeaderAverageEnabled).toBe(false);
    expect(defaults.leaderMirror.crossLeaderAverageLeaders).toEqual([]);
    expect(defaults.leaderMirror.crossLeaderAverageUsd).toBe(0);
    expect(defaults.leaderMirror.crossLeaderAverageMinDiscountPct).toBe(10);
    expect(defaults.leaderMirror.crossLeaderAverageMaxAgeMs).toBe(300_000);
    expect(defaults.leaderMirror.crossLeaderAverageMaxTimes).toBe(1);
    expect(defaults.leaderMirror.crossLeaderAverageMinLeaderSizeUsd).toBe(20);
    expect(defaults.leaderMirror.crossLeaderAverageStepsEnabled).toBe(false);
    expect(defaults.leaderMirror.crossLeaderAverageStartFraction).toBe(0.3);
    expect(defaults.leaderMirror.crossLeaderAverageFullDiscountPct).toBe(50);
    expect(defaults.leaderMirror.crossLeaderAverageMaxTotalFraction).toBe(1);
    expect(defaults.leaderMirror.crossLeaderAverageMinStepUsd).toBe(3);
    expect(defaults.leaderMirror.fundingParkEnabled).toBe(false);
    expect(defaults.leaderMirror.fundingParkRetryMs).toBe(30_000);
    expect(defaults.leaderMirror.fundingParkMax).toBe(10);
    expect(defaults.leaderMirror.leaderOpenBagRetryEnabled).toBe(false);
    expect(defaults.leaderMirror.leaderOpenBagRetryIntervalMs).toBe(60_000);
    expect(defaults.leaderMirror.leaderOpenBagMaxAgeMs).toBe(21_600_000);
    expect(defaults.leaderMirror.leaderOpenBagMaxEntries).toBe(60);
    expect(defaults.leaderMirror.leaderOpenBagMaxPerPass).toBe(5);
    expect(defaults.leaderMirror.leaderOpenBagMinFreeUsd).toBe(0);
    expect(defaults.leaderMirror.tierParkEnabled).toBe(false);
    expect(defaults.leaderMirror.sizeLiqCoef).toBe(0);
    expect(defaults.leaderMirror.sizeLiqExp).toBe(0.866);
    expect(defaults.leaderMirror.sizeLiqMinUsd).toBe(30);
    expect(defaults.leaderMirror.sizeLiqMaxUsd).toBe(120);
    expect(defaults.leaderMirror.sizeLiqMaxPoolSharePct).toBe(0);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_ENABLED: '1',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_LEADERS: 'foreign-a, foreign-b',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_USD: '40',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_STEPS_ENABLED: '1',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_START_FRACTION: '0.4',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_FULL_DISCOUNT_PCT: '60',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MAX_TOTAL_FRACTION: '0.9',
        MILD_DIP_MIRROR_CROSS_LEADER_AVERAGE_MIN_STEP_USD: '4',
        MILD_DIP_MIRROR_FUNDING_PARK_ENABLED: '1',
        MILD_DIP_MIRROR_FUNDING_PARK_RETRY_MS: '45000',
        MILD_DIP_MIRROR_FUNDING_PARK_MAX: '7',
        MILD_DIP_MIRROR_LEADER_OPEN_BAG_ENABLED: '1',
        MILD_DIP_MIRROR_LEADER_OPEN_BAG_RETRY_MS: '45000',
        MILD_DIP_MIRROR_LEADER_OPEN_BAG_MAX_AGE_MS: '7200000',
        MILD_DIP_MIRROR_LEADER_OPEN_BAG_MAX_ENTRIES: '12',
        MILD_DIP_MIRROR_LEADER_OPEN_BAG_MAX_PER_PASS: '3',
        MILD_DIP_MIRROR_LEADER_OPEN_BAG_MIN_FREE_USD: '25',
        MILD_DIP_MIRROR_TIER_PARK_ENABLED: '1',
        MILD_DIP_MIRROR_SIZE_LIQ_COEF: '0.008749',
        MILD_DIP_MIRROR_SIZE_LIQ_EXP: '0.9',
        MILD_DIP_MIRROR_SIZE_MIN_USD: '11',
        MILD_DIP_MIRROR_SIZE_MAX_USD: '99',
        MILD_DIP_MIRROR_SIZE_MAX_POOL_SHARE_PCT: '0.15',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.leaderMirror.crossLeaderAverageEnabled).toBe(true);
    expect(cfg.leaderMirror.crossLeaderAverageLeaders).toEqual(['foreign-a', 'foreign-b']);
    expect(cfg.leaderMirror.crossLeaderAverageUsd).toBe(40);
    expect(cfg.leaderMirror.crossLeaderAverageStepsEnabled).toBe(true);
    expect(cfg.leaderMirror.crossLeaderAverageStartFraction).toBe(0.4);
    expect(cfg.leaderMirror.crossLeaderAverageFullDiscountPct).toBe(60);
    expect(cfg.leaderMirror.crossLeaderAverageMaxTotalFraction).toBe(0.9);
    expect(cfg.leaderMirror.crossLeaderAverageMinStepUsd).toBe(4);
    expect(cfg.leaderMirror.fundingParkEnabled).toBe(true);
    expect(cfg.leaderMirror.fundingParkRetryMs).toBe(45_000);
    expect(cfg.leaderMirror.fundingParkMax).toBe(7);
    expect(cfg.leaderMirror.leaderOpenBagRetryEnabled).toBe(true);
    expect(cfg.leaderMirror.leaderOpenBagRetryIntervalMs).toBe(45_000);
    expect(cfg.leaderMirror.leaderOpenBagMaxAgeMs).toBe(7_200_000);
    expect(cfg.leaderMirror.leaderOpenBagMaxEntries).toBe(12);
    expect(cfg.leaderMirror.leaderOpenBagMaxPerPass).toBe(3);
    expect(cfg.leaderMirror.leaderOpenBagMinFreeUsd).toBe(25);
    expect(cfg.leaderMirror.tierParkEnabled).toBe(true);
    expect(cfg.leaderMirror.sizeLiqCoef).toBe(0.008749);
    expect(cfg.leaderMirror.sizeLiqExp).toBe(0.9);
    expect(cfg.leaderMirror.sizeLiqMinUsd).toBe(11);
    expect(cfg.leaderMirror.sizeLiqMaxUsd).toBe(99);
    expect(cfg.leaderMirror.sizeLiqMaxPoolSharePct).toBe(0.15);
  });

  it('parses configured mirror averaging and cash reconciliation settings', () => {
    const cfg = withConfigEnv({
      ...baseEnv,
      MILD_DIP_MIRROR_AVERAGE_LEVELS_PCT: '50, 25, 25',
      MILD_DIP_MIRROR_AVERAGE_SIZE_MODE: 'bag_mark',
      MILD_DIP_MIRROR_AVERAGE_MAX_USD: '200',
      MILD_DIP_MIRROR_CASH_RECONCILE_INTERVAL_MS: '123456',
    }, () => loadMildDipConfig());
    expect(cfg.leaderMirror.averageLevelsPct).toEqual([25, 50]);
    expect(cfg.leaderMirror.averageSizeMode).toBe('bag_mark');
    expect(cfg.leaderMirror.averageMaxUsd).toBe(200);
    expect(cfg.leaderMirror.cashReconcileIntervalMs).toBe(123456);
  });

  it('defaults and loads emergency data retention settings', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.dataRetentionEmergencyEnabled).toBe(true);
    expect(defaults.dataRetentionEmergencyKeepDays).toBe(2);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_DATA_EMERGENCY_ENABLED: '0',
        MILD_DIP_DATA_EMERGENCY_KEEP_DAYS: '14',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.dataRetentionEmergencyEnabled).toBe(false);
    expect(cfg.dataRetentionEmergencyKeepDays).toBe(14);
  });

  it('rejects an open-bag retry interval below five seconds', () => {
    expect(() =>
      withConfigEnv(
        {
          ...baseEnv,
          MILD_DIP_MIRROR_LEADER_OPEN_BAG_RETRY_MS: '4999',
        },
        () => loadMildDipConfig(),
      ),
    ).toThrow();
  });

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

  it('loads the profitable-exit minimum hold from the environment', () => {
    expect(withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).exit.profitExitMinHoldMs).toBe(0);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_PROFIT_MIN_HOLD_MS: '900000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.profitExitMinHoldMs).toBe(900_000);
    const maxCfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_PROFIT_MIN_HOLD_MS: '14400000',
      },
      () => loadMildDipConfig(),
    );
    expect(maxCfg.exit.profitExitMinHoldMs).toBe(14_400_000);
  });

  it('defaults and loads the underwater hard time stop', () => {
    expect(withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).exit.hardTimeStopMs).toBe(0);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_HARD_TIME_STOP_MS: '5400000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.hardTimeStopMs).toBe(5_400_000);
  });

  it('loads the profitable-exit minimum-hold PnL bypass from the environment', () => {
    expect(
      withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).exit
        .profitExitMinHoldBypassPnlPct,
    ).toBe(0);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_PROFIT_MIN_HOLD_BYPASS_PNL_PCT: '20',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.profitExitMinHoldBypassPnlPct).toBe(20);
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

  it('loads a non-positive probe cap for curve-sized probe entries', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_PROBE_BLOCKED_USD: '0',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.probeBlockedUsd).toBe(0);
  });

  it('loads the entry age and volume/liquidity thresholds', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_ENTRY_MIN_PAIR_AGE_HOURS: '1.25',
        MILD_DIP_ENTRY_MAX_VOL5M_TO_LIQ: '2.5',
        MILD_DIP_ENTRY_MIN_LIQ_USD: '4500',
        MILD_DIP_ENTRY_MIN_TXNS_5M: '20',
        MILD_DIP_ENTRY_MIN_TURNOVER: '0.05',
        MILD_DIP_STRUCTURAL_FALLBACK_ENABLED: '1',
        MILD_DIP_STRUCTURAL_FALLBACK_MAX_PER_MIN: '20',
        MILD_DIP_STRUCTURAL_FALLBACK_MINT_GAP_MS: '30000',
        MILD_DIP_STRUCTURAL_FALLBACK_CACHE_TTL_MS: '15000',
        MILD_DIP_STRUCTURAL_FALLBACK_TIMEOUT_MS: '2500',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.entryMinPairAgeHours).toBe(1.25);
    expect(cfg.entryMaxVol5mToLiq).toBe(2.5);
    expect(cfg.entryMinLiquidityUsd).toBe(4500);
    expect(cfg.entryMinTxns5m).toBe(20);
    expect(cfg.entryMinTurnover5mLiq).toBe(0.05);
    expect(cfg.structuralFallbackEnabled).toBe(true);
    expect(cfg.structuralFallbackMaxPerMin).toBe(20);
    expect(cfg.structuralFallbackMintGapMs).toBe(30_000);
    expect(cfg.structuralFallbackCacheTtlMs).toBe(15_000);
    expect(cfg.structuralFallbackTimeoutMs).toBe(2_500);
  });

  it('defaults the impulse entry floors to disabled', () => {
    const cfg = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(cfg.entryMinTxns5m).toBe(0);
    expect(cfg.entryMinTurnover5mLiq).toBe(0);
  });

  it('defaults the structural fallback to disabled with bounded budgets', () => {
    const cfg = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(cfg.structuralFallbackEnabled).toBe(false);
    expect(cfg.mirrorOwnStructuralEnabled).toBe(false);
    expect(cfg.structuralFallbackMaxPerMin).toBe(20);
    expect(cfg.structuralFallbackMintGapMs).toBe(30_000);
    expect(cfg.structuralFallbackCacheTtlMs).toBe(15_000);
    expect(cfg.structuralFallbackTimeoutMs).toBe(2_500);
  });

  it('defaults the wait-dip signal-depth floor to off', () => {
    const cfg = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(cfg.waitDipMaxDumpFromSignalPct).toBe(0);
  });

  it('loads signal freshness and trough-ready defaults and overrides', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.entrySignalMarkMaxAgeMs).toBe(0);
    expect(defaults.entrySignalMaxDivergencePct).toBe(0);
    expect(defaults.waitDipTroughReadyFraction).toBe(0);
    expect(defaults.entryTroughLookbackMs).toBe(900_000);
    expect(defaults.waitDipMinTroughAgeMs).toBe(0);
    expect(defaults.turnDumpKnifeTroughMinAgeMs).toBe(0);
    expect(defaults.turnDumpKnifeTroughMaxBouncePct).toBe(100);
    const cfg = withConfigEnv({
      ...baseEnv,
      MILD_DIP_ENTRY_TROUGH_LOOKBACK_MS: '600000',
      MILD_DIP_WAIT_DIP_MIN_TROUGH_AGE_MS: '120000',
      MILD_DIP_TURN_DUMP_KNIFE_TROUGH_MIN_AGE_MS: '180000',
      MILD_DIP_TURN_DUMP_KNIFE_TROUGH_MAX_BOUNCE_PCT: '8',
      MILD_DIP_ENTRY_SIGNAL_MARK_MAX_AGE_MS: '45000',
      MILD_DIP_ENTRY_SIGNAL_MAX_DIVERGENCE_PCT: '15',
      MILD_DIP_WAIT_DIP_TROUGH_READY_FRACTION: '0.7',
      MILD_DIP_WAIT_DIP_TROUGH_MIN_AGE_MS: '60000',
      MILD_DIP_WAIT_DIP_TROUGH_MIN_BOUNCE_PCT: '1.5',
      MILD_DIP_WAIT_DIP_TROUGH_MAX_BOUNCE_PCT: '8',
    }, () => loadMildDipConfig());
    expect(cfg.entrySignalMarkMaxAgeMs).toBe(45_000);
    expect(cfg.entrySignalMaxDivergencePct).toBe(15);
    expect(cfg.waitDipTroughReadyFraction).toBe(0.7);
    expect(cfg.entryTroughLookbackMs).toBe(600_000);
    expect(cfg.waitDipMinTroughAgeMs).toBe(120_000);
    expect(cfg.turnDumpKnifeTroughMinAgeMs).toBe(180_000);
    expect(cfg.turnDumpKnifeTroughMaxBouncePct).toBe(8);
    expect(cfg.waitDipTroughMinAgeMs).toBe(60_000);
    expect(cfg.waitDipTroughMinBouncePct).toBe(1.5);
    expect(cfg.waitDipTroughMaxBouncePct).toBe(8);
  });

  it('defaults the entry minimum liquidity threshold to $4000', () => {
    const cfg = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(cfg.entryMinLiquidityUsd).toBe(4000);
  });

  it('loads staged-entry defaults and explicit overrides', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.stagedEntryEnabled).toBe(false);
    expect(defaults.stagedFirstUsd).toBe(5);
    expect(defaults.stagedAddTriggerPct).toBe(8);
    expect(defaults.stagedAddMaxChasePct).toBe(4);
    expect(defaults.stagedAddAnchor).toBe('trough');
    expect(defaults.stagedAddTroughTriggerPct).toBe(8);
    expect(defaults.stagedAddTroughBandPct).toBe(4);
    expect(defaults.stagedAddMinTroughAgeMs).toBe(60_000);
    expect(defaults.stagedAddMult).toBe(2);
    expect(defaults.stagedAddMaxUsd).toBe(0);
    expect(defaults.stagedProfitMinOverAvgPct).toBe(1);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_STAGED_ENTRY_ENABLED: '1',
        MILD_DIP_STAGED_FIRST_USD: '6',
        MILD_DIP_STAGED_ADD_ANCHOR: 'FiLl',
        MILD_DIP_STAGED_ADD_TROUGH_TRIGGER_PCT: '9',
        MILD_DIP_STAGED_ADD_TROUGH_BAND_PCT: '5',
        MILD_DIP_STAGED_ADD_MIN_TROUGH_AGE_MS: '120000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.stagedEntryEnabled).toBe(true);
    expect(cfg.stagedFirstUsd).toBe(6);
    expect(cfg.stagedAddAnchor).toBe('fill');
    expect(cfg.stagedAddTroughTriggerPct).toBe(9);
    expect(cfg.stagedAddTroughBandPct).toBe(5);
    expect(cfg.stagedAddMinTroughAgeMs).toBe(120_000);
    const invalidAnchor = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_STAGED_ADD_ANCHOR: 'garbage',
      },
      () => loadMildDipConfig(),
    );
    expect(invalidAnchor.stagedAddAnchor).toBe('trough');
  });

  it('loads loss-reclaim defaults and explicit overrides', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.exit.lossReclaimMaxLossPct).toBe(0);
    expect(defaults.exit.lossReclaimTargetPct).toBe(2);
    expect(defaults.exit.lossReclaimStopPct).toBe(25);
    expect(defaults.exit.lossReclaimMaxWaitMs).toBe(3_600_000);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_LOSS_RECLAIM_MAX_LOSS_PCT: '10',
        MILD_DIP_EXIT_LOSS_RECLAIM_TARGET_PCT: '2.5',
        MILD_DIP_EXIT_LOSS_RECLAIM_STOP_PCT: '25',
        MILD_DIP_EXIT_LOSS_RECLAIM_MAX_WAIT_MS: '3600000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.lossReclaimMaxLossPct).toBe(10);
    expect(cfg.exit.lossReclaimTargetPct).toBe(2.5);
    expect(cfg.exit.lossReclaimStopPct).toBe(25);
    expect(cfg.exit.lossReclaimMaxWaitMs).toBe(3_600_000);
  });

  it('keeps staged-entry production values in the mild-dip app', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_STAGED_ENTRY_ENABLED: '0'");
    expect(eco).toContain("MILD_DIP_STAGED_FIRST_USD: '5'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_TRIGGER_PCT: '8'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_MAX_CHASE_PCT: '2'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_ANCHOR: 'trough'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_TROUGH_TRIGGER_PCT: '8'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_TROUGH_BAND_PCT: '4'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_MIN_TROUGH_AGE_MS: '60000'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_MULT: '2'");
    expect(eco).toContain("MILD_DIP_STAGED_ADD_MAX_USD: '0'");
    expect(eco).toContain("MILD_DIP_REQUIRE_LEADER_SEEN: '0'");
    expect(eco).toContain("MILD_DIP_LEADER_CO_BUY_ALIGN: '0'");
    expect(eco).toContain("MILD_DIP_STAGED_PROFIT_MIN_OVER_AVG_PCT: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_LOSS_RECLAIM_MAX_LOSS_PCT: '10'");
    expect(eco).toContain("MILD_DIP_EXIT_LOSS_RECLAIM_TARGET_PCT: '2'");
    expect(eco).toContain("MILD_DIP_EXIT_LOSS_RECLAIM_STOP_PCT: '25'");
    expect(eco).toContain("MILD_DIP_EXIT_LOSS_RECLAIM_MAX_WAIT_MS: '3600000'");
  });

  it('keeps ecosystem staged-add anchor keys aligned with the config loader', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    const keys = [
      'MILD_DIP_STAGED_ADD_ANCHOR',
      'MILD_DIP_STAGED_ADD_TROUGH_TRIGGER_PCT',
      'MILD_DIP_STAGED_ADD_TROUGH_BAND_PCT',
      'MILD_DIP_STAGED_ADD_MIN_TROUGH_AGE_MS',
    ];
    for (const key of keys) {
      expect(eco).toContain(`${key}:`);
      expect(
        readFileSync(new URL('../../src/milddip/config.ts', import.meta.url), 'utf8'),
      ).toContain(key);
    }
  });

  it('maps ecosystem loss-reclaim values into the exit config', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    const value = eco.match(/MILD_DIP_EXIT_LOSS_RECLAIM_MAX_LOSS_PCT:\s*'([^']+)'/)?.[1];
    expect(value).toBe('10');
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_LOSS_RECLAIM_MAX_LOSS_PCT: value!,
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.lossReclaimMaxLossPct).toBe(10);
  });

  it('keeps the production thin-liquidity and shallow-branch cuts isolated to mild-dip', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_ENTRY_MIN_LIQ_USD: '6000'");
    expect(eco).toContain("MILD_DIP_TURN_DUMP_SHALLOW_BRANCH: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_LIQ_ABS_FLOOR_USD: '4000'");
  });

  it('keeps the wait-dip signal-depth floor at the live value', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_WAIT_DIP_MAX_DUMP_FROM_SIGNAL_PCT: '25'");
    expect(eco).toContain("MILD_DIP_WAIT_DIP_MAX_WATCH_MS: '600000'");
    const value = eco.match(
      /MILD_DIP_WAIT_DIP_MAX_DUMP_FROM_SIGNAL_PCT:\s*'([^']+)'/,
    )?.[1];
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_WAIT_DIP_MAX_DUMP_FROM_SIGNAL_PCT: value!,
        MILD_DIP_WAIT_DIP_MAX_WATCH_MS: '600000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.waitDipMaxDumpFromSignalPct).toBe(25);
    expect(cfg.waitDipMaxWatchMs).toBe(600_000);
  });

  it('loads GREEN shared gate overrides and preserves their safe defaults', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.greenTurnDumpGate).toBe(true);
    expect(defaults.greenMaxCooldownBouncePct).toBe(0);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_GREEN_TURN_DUMP_GATE: '0',
        MILD_DIP_GREEN_MAX_COOLDOWN_BOUNCE_PCT: '100',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.greenTurnDumpGate).toBe(false);
    expect(cfg.greenMaxCooldownBouncePct).toBe(100);
  });

  it('loads mild-stabilize live lane budgets and trough settings', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MILD_STABILIZE_MAX_PER_HOUR: '12',
        MILD_DIP_MILD_STABILIZE_SKIP_MAX_PER_HOUR: '30',
        MILD_DIP_MILD_STABILIZE_SKIP_MIN_DUMP_PCT: '-4',
        MILD_DIP_MILD_STABILIZE_TROUGH_MIN_AGE_MS: '60000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.mildStabilizeMaxPerHour).toBe(12);
    expect(cfg.mildStabilizeSkipMaxPerHour).toBe(30);
    expect(cfg.mildStabilizeSkipMinDumpPct).toBe(-4);
    expect(cfg.mildStabilizeTroughMinAgeMs).toBe(60_000);
  });

  it('defaults mild-stabilize telemetry to a usable budget and dump floor', () => {
    const cfg = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(cfg.mildStabilizeSkipMaxPerHour).toBe(240);
    expect(cfg.mildStabilizeSkipMinDumpPct).toBe(-3);
  });

  it('keeps the live mild-stabilize profile isolated to mild-dip', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_MILD_STABILIZE_FRESH_ENTRY: '1'");
    expect(eco).toContain("MILD_DIP_MILD_STABILIZE_MAX_DUMP_PCT: '-6'");
    expect(eco).toContain("MILD_DIP_MILD_STABILIZE_TROUGH_MIN_AGE_MS: '60000'");
    expect(eco).toContain("MILD_DIP_MILD_STABILIZE_MAX_PER_HOUR: '12'");
    expect(eco).toContain("MILD_DIP_MILD_STABILIZE_SKIP_MAX_PER_HOUR: '240'");
    expect(eco).toContain("MILD_DIP_MILD_STABILIZE_SKIP_MIN_DUMP_PCT: '-3'");
  });

  it('preserves non-positive entry thresholds through Zod for rollback', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_ENTRY_MIN_PAIR_AGE_HOURS: '-1',
        MILD_DIP_ENTRY_MAX_VOL5M_TO_LIQ: '-1',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.entryMinPairAgeHours).toBe(-1);
    expect(cfg.entryMaxVol5mToLiq).toBe(-1);
  });

  it('loads the first TP rung and profit fill guard from the environment', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_TP_GRID_FIRST_RUNG_PCT: '20',
        MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '4',
        MILD_DIP_EXIT_LOSS_FILL_MAX_SLIP_PCT: '8',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.tpGridFirstRungPct).toBe(20);
    expect(cfg.exit.profitFillMaxSlipPct).toBe(4);
    expect(cfg.exit.lossFillMaxSlipPct).toBe(8);
  });

  it('keeps the production first rung and profit guard values', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_FIRST_RUNG_PCT: '20'");
    expect(eco).toContain("MILD_DIP_EXIT_PROFIT_FILL_MAX_SLIP_PCT: '4'");
    expect(eco).toContain("MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PARTIAL_FRACTION: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PCT: '18'");
    expect(eco).toContain("MILD_DIP_EXIT_LOSS_FILL_MAX_SLIP_PCT: '8'");
  });

  it('loads liquidity-drain exit settings and production defaults', () => {
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_EXIT_LIQ_DRAIN_RATIO: '0.7',
        MILD_DIP_EXIT_LIQ_DRAIN_MIN_AGE_MIN: '10',
        MILD_DIP_EXIT_LIQ_DRAIN_CONFIRM_TICKS: '2',
        MILD_DIP_EXIT_LIQ_DRAIN_SKIP_ARMED_RUNNER: '1',
        MILD_DIP_EXIT_LIQ_ABS_FLOOR_USD: '0',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.exit.liqDrainRatio).toBe(0.7);
    expect(cfg.exit.liqDrainMinAgeMs).toBe(600_000);
    expect(cfg.exit.liqDrainConfirmTicks).toBe(2);
    expect(cfg.exit.liqDrainSkipArmedRunner).toBe(true);
    expect(cfg.exit.liqAbsFloorUsd).toBe(0);
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_LIQ_DRAIN_RATIO: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_LIQ_DRAIN_MIN_AGE_MIN: '10'");
    expect(eco).toContain("MILD_DIP_EXIT_LIQ_DRAIN_CONFIRM_TICKS: '2'");
    expect(eco).toContain("MILD_DIP_EXIT_LIQ_DRAIN_SKIP_ARMED_RUNNER: '1'");
    expect(eco).toContain("MILD_DIP_EXIT_LIQ_ABS_FLOOR_USD: '4000'");
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

  it('keeps production entry age and churn thresholds', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_ENTRY_MIN_PAIR_AGE_HOURS: '0.25'");
    expect(eco).toContain("MILD_DIP_ENTRY_MAX_VOL5M_TO_LIQ: '2'");
    expect(eco).toContain("MILD_DIP_ENTRY_MIN_LIQ_USD: '6000'");
    expect(eco).toContain("MILD_DIP_ENTRY_MIN_TXNS_5M: '20'");
    expect(eco).toContain("MILD_DIP_ENTRY_MIN_TURNOVER: '0.05'");
    expect(eco).toContain("MILD_DIP_STRUCTURAL_FALLBACK_ENABLED: '1'");
    expect(eco).toContain("MILD_DIP_STRUCTURAL_FALLBACK_MAX_PER_MIN: '20'");
    expect(eco).toContain("MILD_DIP_STRUCTURAL_FALLBACK_MINT_GAP_MS: '30000'");
    expect(eco).toContain("MILD_DIP_STRUCTURAL_FALLBACK_CACHE_TTL_MS: '15000'");
    expect(eco).toContain("MILD_DIP_STRUCTURAL_FALLBACK_TIMEOUT_MS: '2500'");
    expect(eco).toContain("MILD_DIP_LSTYLE_MIN_LIQUIDITY_USD: '6000'");
    expect(eco).toContain("MILD_DIP_LSTYLE_MIN_VOL5M_TO_LIQ: '0.15'");
  });

  it('keeps production knife stream integrity guards', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_KNIFE_DEX_GREEN_VETO: '1'");
    expect(eco).toContain("MILD_DIP_KNIFE_STREAM_DIVERGENCE_MAX_PP: '40'");
  });

  it('keeps leader-loop production exit and re-entry values', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_SELL_FRACTION: '1'");
    expect(eco).toContain("MILD_DIP_EXIT_MFE_BANK2_PCT: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_MFE_BANK_SLEEVE_GREEN_PARTIAL_FRACTION: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_PROFIT_MIN_HOLD_MS: '900000'");
    expect(eco).toContain("MILD_DIP_EXIT_PROFIT_MIN_HOLD_BYPASS_PNL_PCT: '20'");
    expect(eco).toContain("MILD_DIP_REBUY_BELOW_EXIT_PCT: '5'");
    expect(eco).toContain("MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT: '0'");
  });

  it('keeps the configured leader-style ring span override', () => {
    const eco = readFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), 'utf8');
    expect(eco).toContain("MILD_DIP_LSTYLE_MIN_RING_SPAN_MS: '60000'");
    expect(
      withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderStyle.minRingSpanMs,
    ).toBe(0);
    const cfg = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_LSTYLE_MIN_RING_SPAN_MS: '60000',
      },
      () => loadMildDipConfig(),
    );
    expect(cfg.leaderStyle.minRingSpanMs).toBe(60_000);
  });
});

describe('mild-dip dust burn configuration', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('defaults disabled with conservative limits and loads overrides', () => {
    const defaults = withConfigEnv(baseEnv, () => loadMildDipConfig());
    expect(defaults.dustBurnEnabled).toBe(false);
    expect(defaults.dustBurnMaxUsd).toBe(0.5);
    expect(defaults.dustBurnMaxPerPass).toBe(20);
    expect(defaults.dustBurnMinAgeMs).toBe(21_600_000);
    expect(defaults.dustBurnSettleMs).toBe(600_000);
    expect(defaults.dustBurnIntervalMs).toBe(21_600_000);
    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_DUST_BURN_ENABLED: '1',
        MILD_DIP_DUST_BURN_MAX_USD: '0.25',
        MILD_DIP_DUST_BURN_MAX_PER_PASS: '7',
        MILD_DIP_DUST_BURN_MIN_AGE_MS: '1000',
        MILD_DIP_DUST_BURN_SETTLE_MS: '2000',
        MILD_DIP_DUST_BURN_INTERVAL_MS: '60000',
      },
      () => loadMildDipConfig(),
    );
    expect(configured.dustBurnEnabled).toBe(true);
    expect(configured.dustBurnMaxUsd).toBe(0.25);
    expect(configured.dustBurnMaxPerPass).toBe(7);
    expect(configured.dustBurnMinAgeMs).toBe(1000);
    expect(configured.dustBurnSettleMs).toBe(2000);
    expect(configured.dustBurnIntervalMs).toBe(60000);
  });
});

describe('mild-dip mirror-only configuration', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('defaults mirror-only off and loads the explicit fail-safe flag', () => {
    expect(withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror.mirrorOnly).toBe(
      false,
    );
    expect(
      withConfigEnv(
        { ...baseEnv, MILD_DIP_MIRROR_ONLY: '1' },
        () => loadMildDipConfig(),
      ).leaderMirror.mirrorOnly,
    ).toBe(true);
  });

  it('defaults the tier lane off and loads its sizing and cap', () => {
    const defaults = withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror;
    expect(defaults.tierEnabled).toBe(false);
    expect(defaults.tierIgnoreStructuralFloors).toBe(false);
    expect(defaults.tierPositionUsd).toBe(10);
    expect(defaults.tierMaxOpen).toBe(5);
    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_TIER_ENABLED: '1',
        MILD_DIP_MIRROR_TIER_IGNORE_FLOORS: '1',
        MILD_DIP_MIRROR_TIER_POSITION_USD: '12',
        MILD_DIP_MIRROR_TIER_MAX_OPEN: '7',
      },
      () => loadMildDipConfig(),
    ).leaderMirror;
    expect(configured.tierEnabled).toBe(true);
    expect(configured.tierIgnoreStructuralFloors).toBe(true);
    expect(configured.tierPositionUsd).toBe(12);
    expect(configured.tierMaxOpen).toBe(7);
  });
});

describe('mild-dip mirror green-copy configuration', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('uses safe defaults and loads green-copy overrides', () => {
    const defaults = withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror;
    expect(defaults.greenCopyEnabled).toBe(false);
    expect(defaults.greenCorridorPct).toBe(1.5);
    expect(defaults.greenCopyMaxPc5mPct).toBe(40);

    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_GREEN_COPY_ENABLED: '1',
        MILD_DIP_MIRROR_GREEN_CORRIDOR_PCT: '2.25',
        MILD_DIP_MIRROR_GREEN_MAX_PC5M_PCT: '55',
      },
      () => loadMildDipConfig(),
    ).leaderMirror;
    expect(configured.greenCopyEnabled).toBe(true);
    expect(configured.greenCorridorPct).toBe(2.25);
    expect(configured.greenCopyMaxPc5mPct).toBe(55);
  });
});

describe('mild-dip mirror entry momentum floors', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('keeps optional floors disabled by default and loads overrides', () => {
    const defaults = withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror;
    expect(defaults.minPc1hPct).toBe(-1000);
    expect(defaults.minPreEntryPc5mPct).toBe(-1000);
    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_MIN_PC1H_PCT: '10',
        MILD_DIP_MIRROR_MIN_PC5M_PCT: '-10',
      },
      () => loadMildDipConfig(),
    ).leaderMirror;
    expect(configured.minPc1hPct).toBe(10);
    expect(configured.minPreEntryPc5mPct).toBe(-10);
  });
});

describe('mild-dip mirror exit refire configuration', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('defaults exit refire off and loads the configured limit', () => {
    const defaults = withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror;
    expect(defaults.exitRefireMax).toBe(0);
    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_EXIT_REFIRE_MAX: '2',
      },
      () => loadMildDipConfig(),
    ).leaderMirror;
    expect(configured.exitRefireMax).toBe(2);
  });
});

describe('mild-dip mirror leader-sell exit configuration', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('defaults off and loads the mirror-only feed settings', () => {
    const defaults = withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror;
    expect(defaults.leaderSellExitEnabled).toBe(false);
    expect(defaults.leaderSellExitMaxAgeMs).toBe(60_000);
    expect(defaults.leaderSellTradesPath).toBe('data/milddip/trades.jsonl');
    expect(defaults.leaderSellLateReconcileIntervalMs).toBe(30_000);
    expect(defaults.leaderSellLateReconcileWindowMs).toBe(3_600_000);
    expect(defaults.leaderSellLateReconcileTailBytes).toBe(2 * 1024 * 1024);
    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_LEADER_SELL_ENABLED: '1',
        MILD_DIP_MIRROR_LEADER_SELL_MAX_AGE_MS: '30000',
        MILD_DIP_MIRROR_LEADER_SELL_TRADES_PATH: '/tmp/leader-trades.jsonl',
        MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_INTERVAL_MS: '15000',
        MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_WINDOW_MS: '1800000',
        MILD_DIP_MIRROR_LEADER_SELL_LATE_RECONCILE_TAIL_BYTES: '1048576',
      },
      () => loadMildDipConfig(),
    ).leaderMirror;
    expect(configured.leaderSellExitEnabled).toBe(true);
    expect(configured.leaderSellExitMaxAgeMs).toBe(30_000);
    expect(configured.leaderSellTradesPath).toBe('/tmp/leader-trades.jsonl');
    expect(configured.leaderSellLateReconcileIntervalMs).toBe(15_000);
    expect(configured.leaderSellLateReconcileWindowMs).toBe(1_800_000);
    expect(configured.leaderSellLateReconcileTailBytes).toBe(1_048_576);
  });
});

describe('mild-dip mirror leader-sell-only configuration', () => {
  const baseEnv = {
    MILD_DIP_EXECUTION_MODE: 'paper',
    MILD_DIP_RPC_URL: 'https://example.invalid',
  };

  it('defaults safety controls off and loads explicit overrides', () => {
    const defaults = withConfigEnv({ ...baseEnv }, () => loadMildDipConfig()).leaderMirror;
    expect(defaults.leaderSellOnlyExit).toBe(false);
    expect(defaults.safetyMaxHoldMs).toBe(0);
    expect(defaults.ladderEnabled).toBe(true);
    expect(defaults.averageMaxPriceImpactPct).toBe(0);
    expect(defaults.ladderMinSettleSec).toBe(45);
    expect(defaults.dustCloseUsd).toBe(10);
    const configured = withConfigEnv(
      {
        ...baseEnv,
        MILD_DIP_MIRROR_LEADER_SELL_ONLY: '1',
        MILD_DIP_MIRROR_SAFETY_MAX_HOLD_MS: '86400000',
        MILD_DIP_MIRROR_LADDER_MIN_SETTLE_SEC: '0',
        MILD_DIP_MIRROR_DUST_CLOSE_USD: '0',
        MILD_DIP_MIRROR_AVERAGE_MAX_PRICE_IMPACT_PCT: '5',
      },
      () => loadMildDipConfig(),
    ).leaderMirror;
    expect(configured.leaderSellOnlyExit).toBe(true);
    expect(configured.safetyMaxHoldMs).toBe(86_400_000);
    expect(configured.ladderMinSettleSec).toBe(0);
    expect(configured.dustCloseUsd).toBe(0);
    expect(configured.averageMaxPriceImpactPct).toBe(5);
  });
});
