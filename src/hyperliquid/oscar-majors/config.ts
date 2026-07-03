import type { HlTwapLiveConfig } from '../twap/live/config.js';

export type HlOscarMajorsMode = 'dry_run' | 'live';
export type HlMajorsStrategyMode = 'knife' | 'scalp' | 'both';

export type HlOscarMajorsScalpConfig = {
  enabled: boolean;
  mode: HlOscarMajorsMode;
  dipPct: number;
  windowMin: number;
  /** Skip entry when position in 24h range exceeds this (0–1); null = filter off. */
  rangeMaxPct: number | null;
  tpRungs: number[];
  slPct: number;
  timeStopMin: number;
  cooldownMin: number;
  marginUsd: number;
  leverage: number;
  grossUsd: number;
  maxOpenPositions: number;
  tpSellFrac: number;
  trailSellFrac: number;
  trailArmPct: number;
  trailStepPct: number;
  maxFunding8h: number;
};

export type HlOscarMajorsConfig = {
  enabled: boolean;
  mode: HlOscarMajorsMode;
  /** Which strategy lanes are active: knife, scalp, or both (mutex per coin). */
  strategyMode: HlMajorsStrategyMode;
  scalp: HlOscarMajorsScalpConfig;
  privateKey: string | null;
  masterAddress: string;
  testnet: boolean;
  leverage: number;
  positionNotionalUsd: number;
  positionMarginUsd: number;
  stagedEntryEnabled: boolean;
  leg1GrossUsd: number;
  leg2GrossUsd: number;
  leg3GrossUsd: number;
  leg2DropPct: number;
  leg3DropPct: number;
  positionKillDropPct: number;
  stagedKillDropPct: number;
  dipMinDropPct: number;
  dipMaxDropPct: number;
  dipMinImpulsePct: number;
  dipLookbackWindowsMin: number[];
  dipCooldownMin: number;
  timeStopHours: number;
  maxOpenPositions: number;
  /** Cap simultaneous entries (corr guard; default = maxOpenPositions). */
  maxConcurrentPositions: number;
  minDayVolumeUsd: number;
  pollIntervalMs: number;
  candleRefreshMs: number;
  scanBatchSize: number;
  candleFetchConcurrency: number;
  slippageTolerance: number;
  journalPath: string;
  heartbeatPath: string;
  drawdownStopUsd: number;
  drawdownCheckMs: number;
  /** Whitelist coins (uppercase). */
  whitelist: string[];
  btcTpRungs: number[];
  ethTpRungs: number[];
  tpSellFrac: number;
  trailSellFrac: number;
  btcTrailArmFrac: number;
  btcTrailStepDropFrac: number;
  ethTrailArmFrac: number;
  ethTrailStepDropFrac: number;
  /** Full close when remaining size ≤ this % of original (default 10). */
  remainderClosePct: number;
  /** Free collateral kept on top of each new open margin (USD). */
  marginReserveUsd: number;
};

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function parseFracList(spec: string, fallback: number[]): number[] {
  const parts = spec
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : fallback;
}

function parseWindows(spec: string): number[] {
  return spec
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseCoinList(spec: string, fallback: string[]): string[] {
  const parts = spec
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

export function defaultLegGrossUsd(totalUsd: number): { leg1: number; leg2: number; leg3: number } {
  const leg1 = Math.round(totalUsd * 0.3 * 100) / 100;
  const leg2 = Math.round(totalUsd * 0.3 * 100) / 100;
  const leg3 = Math.round((totalUsd - leg1 - leg2) * 100) / 100;
  return { leg1, leg2, leg3 };
}

function resolvePositionGrossUsd(leverage: number): number {
  const marginUsd = envNum('HL_MAJORS_MARGIN_USD', 0);
  if (marginUsd > 0) {
    return Math.max(1, marginUsd * leverage);
  }
  return Math.max(
    1,
    envNum('HL_MAJORS_POSITION_NOTIONAL_USD', envNum('HL_MAJORS_NOTIONAL_USD', 100)),
  );
}

export function hlMajorsSizingFromEnv(): {
  leverage: number;
  grossUsd: number;
  marginUsd: number;
} {
  const leverage = Math.max(1, Math.round(envNum('HL_MAJORS_LEVERAGE', 2)));
  const grossUsd = resolvePositionGrossUsd(leverage);
  return { leverage, grossUsd, marginUsd: grossUsd / leverage };
}

/** Gross/margin/leverage for dashboard tiles (reads same env as bot). */
export function hlOscarMajorsSizingFromEnv(): {
  leverage: number;
  grossUsd: number;
  marginUsd: number;
} {
  const leverage = Math.max(1, Math.round(envNum('HL_MAJORS_LEVERAGE', 2)));
  const positionNotionalUsd = resolvePositionGrossUsd(leverage);
  return {
    leverage,
    grossUsd: positionNotionalUsd,
    marginUsd: positionNotionalUsd / leverage,
  };
}

function parseStrategyMode(raw: string | undefined): HlMajorsStrategyMode {
  const v = raw?.trim().toLowerCase();
  if (v === 'scalp' || v === 'both') return v;
  return 'knife';
}

function resolveScalpGrossUsd(leverage: number): { marginUsd: number; grossUsd: number } {
  const marginUsd = Math.max(1, envNum('HL_MAJORS_SCALP_MARGIN_USD', 25));
  return { marginUsd, grossUsd: marginUsd * leverage };
}

function loadScalpConfig(privateKey: string | null): HlOscarMajorsScalpConfig {
  const leverage = Math.max(1, Math.round(envNum('HL_MAJORS_SCALP_LEVERAGE', 2)));
  const { marginUsd, grossUsd } = resolveScalpGrossUsd(leverage);
  const scalpEnabled = envBool('HL_MAJORS_SCALP_ENABLED', true);
  const scalpLiveEnabled = envBool('HL_MAJORS_SCALP_LIVE_ENABLED', false);
  const scalpDryRun = envBool('HL_MAJORS_SCALP_DRY_RUN', true);
  let scalpMode: HlOscarMajorsMode = 'dry_run';
  if (scalpEnabled && scalpLiveEnabled && !scalpDryRun && privateKey) {
    scalpMode = 'live';
  }

  const rangeFilterEnabled = envBool('HL_MAJORS_SCALP_RANGE_FILTER', true);
  const rangeMaxPct = rangeFilterEnabled
    ? Math.max(0, Math.min(1, envNum('HL_MAJORS_SCALP_RANGE_MAX_PCT', 0.4)))
    : null;

  return {
    enabled: scalpEnabled,
    mode: scalpMode,
    dipPct: envNum('HL_MAJORS_SCALP_DIP_PCT', -2),
    windowMin: Math.max(15, envNum('HL_MAJORS_SCALP_WINDOW_MIN', 120)),
    rangeMaxPct,
    tpRungs: parseFracList(
      process.env.HL_MAJORS_SCALP_TP_RUNGS?.trim() || '0.005,0.01',
      [0.005, 0.01],
    ),
    slPct: Math.max(0.1, envNum('HL_MAJORS_SCALP_SL_PCT', 2.5)),
    timeStopMin: Math.max(15, envNum('HL_MAJORS_SCALP_TIME_STOP_MIN', 240)),
    cooldownMin: envNum('HL_MAJORS_SCALP_COOLDOWN_MIN', 30),
    marginUsd,
    leverage,
    grossUsd,
    maxOpenPositions: Math.max(1, Math.round(envNum('HL_MAJORS_SCALP_MAX_OPEN', 2))),
    tpSellFrac: envNum('HL_MAJORS_SCALP_TP_SELL_FRAC', 0.5),
    trailSellFrac: envNum('HL_MAJORS_SCALP_TRAIL_SELL_FRAC', 0.25),
    trailArmPct: envNum('HL_MAJORS_SCALP_TRAIL_ARM_PCT', 0.8),
    trailStepPct: envNum('HL_MAJORS_SCALP_TRAIL_STEP_PCT', 0.4),
    maxFunding8h: envNum('HL_MAJORS_SCALP_MAX_FUNDING_8H', 0.0001),
  };
}

export function loadHlOscarMajorsConfig(): HlOscarMajorsConfig {
  const leverage = Math.max(1, Math.round(envNum('HL_MAJORS_LEVERAGE', 2)));
  const positionNotionalUsd = resolvePositionGrossUsd(leverage);
  const positionMarginUsd = positionNotionalUsd / leverage;
  const stagedEntryEnabled = envBool('HL_MAJORS_STAGED_ENTRY', false);
  const legs = stagedEntryEnabled
    ? defaultLegGrossUsd(positionNotionalUsd)
    : { leg1: positionNotionalUsd, leg2: 0, leg3: 0 };
  const privateKey =
    process.env.HL_MAJORS_PRIVATE_KEY?.trim() ||
    process.env.HL_OSCAR_PRIVATE_KEY?.trim() ||
    process.env.HL_TWAP_LIVE_PRIVATE_KEY?.trim() ||
    null;
  const liveEnabled = envBool('HL_MAJORS_LIVE_ENABLED', false);
  const explicitDry = envBool('HL_MAJORS_DRY_RUN', true);
  const mode: HlOscarMajorsMode =
    liveEnabled && !explicitDry && privateKey ? 'live' : 'dry_run';

  const strategyMode = parseStrategyMode(process.env.HL_MAJORS_MODE);
  const scalp = loadScalpConfig(privateKey);

  const dataDir =
    process.env.HL_MAJORS_DATA_DIR?.trim() ||
    `${process.cwd()}/data/hl-oscar-majors`;

  const maxOpenPositions = Math.max(1, Math.round(envNum('HL_MAJORS_MAX_OPEN_POSITIONS', 2)));
  const maxConcurrentRaw = envNum('HL_MAJORS_MAX_CONCURRENT', 0);
  const maxConcurrentPositions =
    maxConcurrentRaw > 0
      ? Math.min(maxOpenPositions, Math.round(maxConcurrentRaw))
      : maxOpenPositions;

  return {
    enabled: envBool('HL_MAJORS_ENABLED', true),
    mode,
    strategyMode,
    scalp,
    privateKey,
    masterAddress: (
      process.env.HL_MAJORS_MASTER_ADDRESS?.trim() ||
      process.env.HL_OSCAR_MASTER_ADDRESS?.trim() ||
      process.env.HL_TWAP_MASTER_ADDRESS?.trim() ||
      '0x37adDf55f2d36e34Bb9a8d79546591131FFecdd3'
    ).toLowerCase(),
    testnet: envBool('HL_MAJORS_TESTNET', false),
    leverage,
    positionNotionalUsd,
    positionMarginUsd,
    stagedEntryEnabled,
    leg1GrossUsd: envNum('HL_MAJORS_LEG1_USD', legs.leg1),
    leg2GrossUsd: envNum('HL_MAJORS_LEG2_USD', legs.leg2),
    leg3GrossUsd: envNum('HL_MAJORS_LEG3_USD', legs.leg3),
    leg2DropPct: envNum('HL_MAJORS_LEG2_DROP_PCT', 3),
    leg3DropPct: envNum('HL_MAJORS_LEG3_DROP_PCT', 5),
    positionKillDropPct: Math.max(1, envNum('HL_MAJORS_KILL_PCT', 15)),
    stagedKillDropPct: Math.max(1, envNum('HL_MAJORS_STAGED_KILL_DROP_PCT', 10)),
    dipMinDropPct: envNum('HL_MAJORS_DIP_MIN_PCT', -6),
    dipMaxDropPct: envNum('HL_MAJORS_DIP_MAX_PCT', -50),
    dipMinImpulsePct: envNum('HL_MAJORS_DIP_MIN_IMPULSE_PCT', 0),
    dipLookbackWindowsMin: parseWindows(
      process.env.HL_MAJORS_DIP_WINDOWS_MIN?.trim() || '120,360,720',
    ),
    dipCooldownMin: envNum('HL_MAJORS_DIP_COOLDOWN_MIN', 30),
    timeStopHours: envNum('HL_MAJORS_TIME_STOP_HOURS', 12),
    maxOpenPositions,
    maxConcurrentPositions,
    minDayVolumeUsd: envNum('HL_MAJORS_MIN_DAY_VOLUME_USD', 1_000_000),
    pollIntervalMs: Math.max(5_000, envNum('HL_MAJORS_POLL_MS', 60_000)),
    candleRefreshMs: Math.max(60_000, envNum('HL_MAJORS_CANDLE_REFRESH_MS', 300_000)),
    scanBatchSize: Math.max(1, Math.round(envNum('HL_MAJORS_SCAN_BATCH_SIZE', 2))),
    candleFetchConcurrency: Math.max(1, Math.round(envNum('HL_MAJORS_CANDLE_CONCURRENCY', 2))),
    slippageTolerance: Math.max(0.001, envNum('HL_MAJORS_SLIPPAGE_TOLERANCE', 0.01)),
    journalPath:
      process.env.HL_MAJORS_JOURNAL_JSONL?.trim() || `${dataDir}/live.jsonl`,
    heartbeatPath:
      process.env.HL_MAJORS_HEARTBEAT_PATH?.trim() || `${dataDir}/heartbeat.json`,
    drawdownStopUsd: Math.max(0, envNum('HL_MAJORS_DRAWDOWN_STOP_USD', 300)),
    drawdownCheckMs: Math.max(10_000, envNum('HL_MAJORS_DRAWDOWN_CHECK_MS', 60_000)),
    whitelist: parseCoinList(process.env.HL_MAJORS_WHITELIST?.trim() || 'BTC,ETH', ['BTC', 'ETH']),
    btcTpRungs: parseFracList(
      process.env.HL_MAJORS_BTC_TP_RUNGS?.trim() || '0.02,0.03,0.04',
      [0.02, 0.03, 0.04],
    ),
    ethTpRungs: parseFracList(
      process.env.HL_MAJORS_ETH_TP_RUNGS?.trim() || '0.015,0.02,0.025',
      [0.015, 0.02, 0.025],
    ),
    tpSellFrac: envNum('HL_MAJORS_TP_SELL_FRAC', 0.5),
    trailSellFrac: envNum('HL_MAJORS_TRAIL_SELL_FRAC', 0.25),
    btcTrailArmFrac: envNum('HL_MAJORS_BTC_TRAIL_ARM_FRAC', 0.02),
    btcTrailStepDropFrac: envNum('HL_MAJORS_BTC_TRAIL_STEP_DROP_FRAC', 0.01),
    ethTrailArmFrac: envNum('HL_MAJORS_ETH_TRAIL_ARM_FRAC', 0.015),
    ethTrailStepDropFrac: envNum('HL_MAJORS_ETH_TRAIL_STEP_DROP_FRAC', 0.008),
    remainderClosePct: Math.max(0, Math.min(100, envNum('HL_MAJORS_REMAINDER_CLOSE_PCT', 10))),
    marginReserveUsd: Math.max(
      0,
      envNum(
        'HL_MAJORS_MARGIN_RESERVE_USD',
        envNum('HL_OSCAR_MARGIN_RESERVE_USD', 25),
      ),
    ),
  };
}

/** Map majors config to shared HL TWAP exchange client config. */
export function toHlTwapLiveConfig(cfg: HlOscarMajorsConfig): HlTwapLiveConfig {
  const entryGrossUsd = cfg.stagedEntryEnabled ? cfg.leg1GrossUsd : cfg.positionNotionalUsd;
  const leg1Margin = entryGrossUsd / cfg.leverage;
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    privateKey: cfg.privateKey,
    notionalUsd: leg1Margin,
    marginLev3Usd: leg1Margin,
    marginLev5Usd: leg1Margin,
    marginLev7Usd: leg1Margin,
    dynamicMargin: false,
    marginMaxUsd: leg1Margin,
    marginMinUsd: leg1Margin,
    dynamicMarginMaxAtOpenCount: 0,
    dynamicMarginMinAtOpenCount: 1,
    dynamicMarginDcaLevelsReserve: 0,
    marginReserveUsd: cfg.marginReserveUsd,
    coinMaxLegs: 3,
    coinMaxGrossUsd: cfg.positionNotionalUsd * 2,
    minImpactPct: 0,
    ladderMode: 'off',
    ladderStepPct: 2,
    ladderSlicePct: 30,
    ladderDcaPctOfInitial: 0,
    slippageTolerance: cfg.slippageTolerance,
    leverage: cfg.leverage,
    exitSlicesShort: 1,
    exitSlicesLong: 1,
    exitSliceIntervalMs: 0,
    execSliceUsd: cfg.positionNotionalUsd,
    execSliceGapMs: 0,
    journalPath: cfg.journalPath,
    testnet: cfg.testnet,
    masterAddress: cfg.masterAddress,
  };
}
