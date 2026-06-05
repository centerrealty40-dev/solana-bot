export type HlTwapLiveMode = 'dry_run' | 'live';

export type HlTwapLiveConfig = {
  enabled: boolean;
  mode: HlTwapLiveMode;
  /** Hyperliquid wallet private key (0x…). Required when mode=live. */
  privateKey: string | null;
  /** Initial notional per TWAP signal (USD). */
  notionalUsd: number;
  /** Min TWAP impact % for new entries (same as watch filter). */
  minImpactPct: number;
  /** TP/DCA step from entry anchor (%). */
  ladderStepPct: number;
  /** Each TP/DCA slice as % of initial notional. */
  ladderSlicePct: number;
  /** IoC price buffer for market-like orders. */
  slippageTolerance: number;
  /** Default cross leverage for new positions. */
  leverage: number;
  journalPath: string;
  testnet: boolean;
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
    notionalUsd: Math.max(1, envNum('HL_TWAP_LIVE_NOTIONAL_USD', 100)),
    minImpactPct: Math.max(0, envNum('HL_TWAP_LIVE_MIN_IMPACT_PCT', 3)),
    ladderStepPct: Math.max(0.1, envNum('HL_TWAP_LIVE_LADDER_STEP_PCT', 3)),
    ladderSlicePct: Math.max(0.1, Math.min(100, envNum('HL_TWAP_LIVE_LADDER_SLICE_PCT', 10))),
    slippageTolerance: Math.max(0.001, envNum('HL_TWAP_LIVE_SLIPPAGE_TOLERANCE', 0.01)),
    leverage: Math.max(1, Math.round(envNum('HL_TWAP_LIVE_LEVERAGE', 5))),
    journalPath:
      process.env.HL_TWAP_LIVE_JSONL?.trim() ||
      `${process.cwd()}/data/hl-twap/live.jsonl`,
    testnet: envBool('HL_TWAP_LIVE_TESTNET', false),
  };
}
