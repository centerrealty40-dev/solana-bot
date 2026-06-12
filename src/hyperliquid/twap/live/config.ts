import { defaultExitSliceIntervalMs } from './chunked-exit.js';
import { minImpactPctHour } from '../coin-twap-analysis.js';

export type HlTwapLiveMode = 'dry_run' | 'live';

export type HlTwapLiveConfig = {
  enabled: boolean;
  mode: HlTwapLiveMode;
  /** Hyperliquid wallet private key (0x…). Required when mode=live. */
  privateKey: string | null;
  /** Margin (collateral) per TWAP signal (USD). Position size = margin × leverage. */
  notionalUsd: number;
  /** Entry margin when HL effective max leverage ≤ 3× (USD). */
  marginLev3Usd: number;
  /** Entry margin when HL effective max leverage is 4–5× (USD). */
  marginLev5Usd: number;
  /** Entry margin when HL effective max leverage ≥ 6× (USD); defaults to notionalUsd. */
  marginLev7Usd: number;
  /** Scale entry margin by open count and free collateral (live). */
  dynamicMargin: boolean;
  /** Max entry margin when few positions are open (USD). */
  marginMaxUsd: number;
  /** Min entry margin when many positions are open (USD). */
  marginMinUsd: number;
  /** Open count at or below which max margin applies. */
  dynamicMarginMaxAtOpenCount: number;
  /** Open count at or above which min margin applies. */
  dynamicMarginMinAtOpenCount: number;
  /** DCA ladder levels reserved when sizing a new open. */
  dynamicMarginDcaLevelsReserve: number;
  /** Collateral reserve kept on account for new opens (USD). */
  marginReserveUsd: number;
  /** Max concurrent journal legs per coin+side (incl. pending schedules). */
  coinMaxLegs: number;
  /** Max exchange gross USD per coin+side book (entries + DCA). */
  coinMaxGrossUsd: number;
  /** Min net hourly impact %/h on dominant side for entries. */
  minImpactPct: number;
  /** TP/DCA step as HL ROE % (uPnL / margin), same as clearinghouse UI. */
  ladderStepPct: number;
  /** Each TP/DCA slice as % of current gross position. */
  ladderSlicePct: number;
  /** IoC price buffer for market-like orders. */
  slippageTolerance: number;
  /** Default cross leverage for new positions. */
  leverage: number;
  /** Exit TWAP slices for shorts (0/1 = instant flatten). Default 10. */
  exitSlicesShort: number;
  /** Exit TWAP slices for longs (0/1 = instant). Default 3 (backtest: faster than 10 on longs). */
  exitSlicesLong: number;
  /** Ms between exit slices (default 30s, aligned with HL TWAP child orders). */
  exitSliceIntervalMs: number;
  /** Max gross USD per exchange child order (0 = no split). Default 200. */
  execSliceUsd: number;
  /** Ms between exec sub-slices within one logical order. Default 5000. */
  execSliceGapMs: number;
  journalPath: string;
  testnet: boolean;
  /** Master HL account where perp positions live (agent wallet signs orders). */
  masterAddress: string;
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
  return v === '1' || v.toLowerCase() === 'true' || v === 'yes';
}

export function loadHlTwapLiveConfig(): HlTwapLiveConfig {
  const privateKey = process.env.HL_TWAP_LIVE_PRIVATE_KEY?.trim() || null;
  const explicitDry = envBool('HL_TWAP_LIVE_DRY_RUN', true);
  const mode: HlTwapLiveMode =
    !explicitDry && privateKey ? 'live' : 'dry_run';

  return {
    enabled: envBool('HL_TWAP_LIVE_ENABLED', false),
    mode,
    privateKey,
    notionalUsd: Math.max(1, envNum('HL_TWAP_LIVE_NOTIONAL_USD', 800)),
    marginLev3Usd: Math.max(1, envNum('HL_TWAP_LIVE_MARGIN_LEV3_USD', 1500)),
    marginLev5Usd: Math.max(1, envNum('HL_TWAP_LIVE_MARGIN_LEV5_USD', 1000)),
    marginLev7Usd: Math.max(
      1,
      envNum('HL_TWAP_LIVE_MARGIN_LEV7_USD', envNum('HL_TWAP_LIVE_NOTIONAL_USD', 800)),
    ),
    dynamicMargin: envBool('HL_TWAP_LIVE_DYNAMIC_MARGIN', false),
    marginMaxUsd: Math.max(1, envNum('HL_TWAP_LIVE_MARGIN_MAX_USD', 800)),
    marginMinUsd: Math.max(1, envNum('HL_TWAP_LIVE_MARGIN_MIN_USD', 800)),
    dynamicMarginMaxAtOpenCount: Math.max(0, Math.round(envNum('HL_TWAP_LIVE_DYNAMIC_MARGIN_MAX_AT', 2))),
    dynamicMarginMinAtOpenCount: Math.max(
      1,
      Math.round(envNum('HL_TWAP_LIVE_DYNAMIC_MARGIN_MIN_AT', 5)),
    ),
    dynamicMarginDcaLevelsReserve: Math.max(
      0,
      Math.round(envNum('HL_TWAP_LIVE_DYNAMIC_MARGIN_DCA_RESERVE', 2)),
    ),
    marginReserveUsd: Math.max(0, envNum('HL_TWAP_MARGIN_RESERVE_USD', 50)),
    coinMaxLegs: Math.max(1, Math.round(envNum('HL_TWAP_LIVE_COIN_MAX_LEGS', 2))),
    coinMaxGrossUsd: Math.max(1, envNum('HL_TWAP_LIVE_MAX_BOOK_GROSS_USD', 12_000)),
    minImpactPct: minImpactPctHour(),
    ladderStepPct: Math.max(0.1, envNum('HL_TWAP_LIVE_LADDER_STEP_PCT', 2)),
    ladderSlicePct: Math.max(0.1, Math.min(100, envNum('HL_TWAP_LIVE_LADDER_SLICE_PCT', 30))),
    slippageTolerance: Math.max(0.001, envNum('HL_TWAP_LIVE_SLIPPAGE_TOLERANCE', 0.01)),
    leverage: Math.max(1, Math.round(envNum('HL_TWAP_LIVE_LEVERAGE', 7))),
    exitSlicesShort: Math.max(0, Math.round(envNum('HL_TWAP_LIVE_EXIT_SLICES', 10))),
    exitSlicesLong: Math.max(
      0,
      Math.round(envNum('HL_TWAP_LIVE_EXIT_SLICES_LONG', envNum('HL_TWAP_LIVE_EXIT_SLICES_BUY', 3))),
    ),
    exitSliceIntervalMs: defaultExitSliceIntervalMs(),
    execSliceUsd: Math.max(0, envNum('HL_TWAP_EXEC_SLICE_USD', 200)),
    execSliceGapMs: Math.max(0, envNum('HL_TWAP_EXEC_SLICE_GAP_MS', 5000)),
    journalPath:
      process.env.HL_TWAP_LIVE_JSONL?.trim() ||
      `${process.cwd()}/data/hl-twap/live.jsonl`,
    testnet: envBool('HL_TWAP_LIVE_TESTNET', false),
    masterAddress: (
      process.env.HL_TWAP_MASTER_ADDRESS?.trim() ||
      '0x37adDf55f2d36e34Bb9a8d79546591131FFecdd3'
    ).toLowerCase(),
  };
}
