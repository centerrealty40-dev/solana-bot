import type { HlTwapLiveConfig } from '../twap/live/config.js';

export type HlOscarPerpMode = 'dry_run' | 'live';

export type HlOscarPerpConfig = {
  enabled: boolean;
  mode: HlOscarPerpMode;
  privateKey: string | null;
  masterAddress: string;
  testnet: boolean;
  leverage: number;
  /** Total gross notional per full position (all legs). */
  positionNotionalUsd: number;
  leg1GrossUsd: number;
  leg2GrossUsd: number;
  leg3GrossUsd: number;
  leg2DropPct: number;
  leg3DropPct: number;
  stagedKillDropPct: number;
  dipMinDropPct: number;
  dipMaxDropPct: number;
  dipMinImpulsePct: number;
  dipLookbackWindowsMin: number[];
  dipCooldownMin: number;
  timeStopHours: number;
  maxOpenPositions: number;
  minDayVolumeUsd: number;
  pollIntervalMs: number;
  candleRefreshMs: number;
  /** Max coins to scan for new entries per tick (rotating batch). */
  scanBatchSize: number;
  candleFetchConcurrency: number;
  slippageTolerance: number;
  journalPath: string;
  heartbeatPath: string;
  drawdownStopUsd: number;
  drawdownCheckMs: number;
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

/** Scale Oscar legs to total notional: ~30% / 30% / 40% ($15+$15+$20 @ $50). */
export function defaultLegGrossUsd(totalUsd: number): { leg1: number; leg2: number; leg3: number } {
  const leg1 = Math.round(totalUsd * 0.3 * 100) / 100;
  const leg2 = Math.round(totalUsd * 0.3 * 100) / 100;
  const leg3 = Math.round((totalUsd - leg1 - leg2) * 100) / 100;
  return { leg1, leg2, leg3 };
}

export function loadHlOscarPerpConfig(): HlOscarPerpConfig {
  const positionNotionalUsd = Math.max(1, envNum('HL_OSCAR_POSITION_NOTIONAL_USD', 50));
  const legs = defaultLegGrossUsd(positionNotionalUsd);
  const privateKey =
    process.env.HL_OSCAR_PRIVATE_KEY?.trim() ||
    process.env.HL_TWAP_LIVE_PRIVATE_KEY?.trim() ||
    null;
  const liveEnabled = envBool('HL_OSCAR_LIVE_ENABLED', false);
  const explicitDry = envBool('HL_OSCAR_DRY_RUN', true);
  const mode: HlOscarPerpMode =
    liveEnabled && !explicitDry && privateKey ? 'live' : 'dry_run';

  const dataDir =
    process.env.HL_OSCAR_DATA_DIR?.trim() ||
    `${process.cwd()}/data/hl-oscar-perp`;

  return {
    enabled: envBool('HL_OSCAR_ENABLED', true),
    mode,
    privateKey,
    masterAddress: (
      process.env.HL_OSCAR_MASTER_ADDRESS?.trim() ||
      process.env.HL_TWAP_MASTER_ADDRESS?.trim() ||
      '0x37adDf55f2d36e34Bb9a8d79546591131FFecdd3'
    ).toLowerCase(),
    testnet: envBool('HL_OSCAR_TESTNET', false),
    leverage: Math.max(1, Math.round(envNum('HL_OSCAR_LEVERAGE', 2))),
    positionNotionalUsd,
    leg1GrossUsd: envNum('HL_OSCAR_LEG1_USD', legs.leg1),
    leg2GrossUsd: envNum('HL_OSCAR_LEG2_USD', legs.leg2),
    leg3GrossUsd: envNum('HL_OSCAR_LEG3_USD', legs.leg3),
    leg2DropPct: envNum('HL_OSCAR_LEG2_DROP_PCT', 5),
    leg3DropPct: envNum('HL_OSCAR_LEG3_DROP_PCT', 20),
    stagedKillDropPct: envNum('HL_OSCAR_STAGED_KILL_DROP_PCT', 50),
    dipMinDropPct: envNum('HL_OSCAR_DIP_MIN_PCT', -10),
    dipMaxDropPct: envNum('HL_OSCAR_DIP_MAX_PCT', -50),
    dipMinImpulsePct: envNum('HL_OSCAR_DIP_MIN_IMPULSE_PCT', 12),
    dipLookbackWindowsMin: parseWindows(
      process.env.HL_OSCAR_DIP_WINDOWS_MIN?.trim() || '120,360,720',
    ),
    dipCooldownMin: envNum('HL_OSCAR_DIP_COOLDOWN_MIN', 30),
    timeStopHours: envNum('HL_OSCAR_TIME_STOP_HOURS', 12),
    maxOpenPositions: Math.max(1, Math.round(envNum('HL_OSCAR_MAX_OPEN_POSITIONS', 10))),
    minDayVolumeUsd: envNum('HL_OSCAR_MIN_DAY_VOLUME_USD', 100_000),
    pollIntervalMs: Math.max(5_000, envNum('HL_OSCAR_POLL_MS', 60_000)),
    candleRefreshMs: Math.max(60_000, envNum('HL_OSCAR_CANDLE_REFRESH_MS', 300_000)),
    scanBatchSize: Math.max(5, Math.round(envNum('HL_OSCAR_SCAN_BATCH_SIZE', 25))),
    candleFetchConcurrency: Math.max(1, Math.round(envNum('HL_OSCAR_CANDLE_CONCURRENCY', 4))),
    slippageTolerance: Math.max(0.001, envNum('HL_OSCAR_SLIPPAGE_TOLERANCE', 0.01)),
    journalPath:
      process.env.HL_OSCAR_JOURNAL_JSONL?.trim() || `${dataDir}/live.jsonl`,
    heartbeatPath:
      process.env.HL_OSCAR_HEARTBEAT_PATH?.trim() || `${dataDir}/heartbeat.json`,
    drawdownStopUsd: Math.max(0, envNum('HL_OSCAR_DRAWDOWN_STOP_USD', 500)),
    drawdownCheckMs: Math.max(10_000, envNum('HL_OSCAR_DRAWDOWN_CHECK_MS', 60_000)),
  };
}

function parseWindows(spec: string): number[] {
  return spec
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Map Oscar config to shared HL TWAP exchange client config. */
export function toHlTwapLiveConfig(cfg: HlOscarPerpConfig): HlTwapLiveConfig {
  const leg1Margin = cfg.leg1GrossUsd / cfg.leverage;
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
    marginReserveUsd: 0,
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
