import { z } from 'zod';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';

/** Lane id / open-map suffix — see LIVE_OSCAR_PERVYY_VYSTREL_SPEC §2. */
export const PERVYY_VYSTREL_POSITION_SOURCE = 'pervyy_vystrel' as const;
export const PERVYY_VYSTREL_EXIT_POLICY_ID = 'pervyy_vystrel_v1' as const;
export const PERVYY_VYSTREL_OPEN_MAP_SUFFIX = '::pervyy_vystrel' as const;

const PervyyVystrelModeSchema = z.enum(['off', 'shadow', 'gate']);

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

/** Typed env contract for tier «Первый выстрел» (spec v0.4). Eval lane — PR3. */
export const PervyyVystrelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: PervyyVystrelModeSchema.default('off'),
  failOpen: z.boolean().default(true),
  /** Staged entry: 2 legs × legUsd (runner_lite pattern, smaller sizing). */
  legUsd: z.coerce.number().positive().default(25),
  positionUsd: z.coerce.number().positive().default(50),
  maxConcurrent: z.coerce.number().int().min(1).max(10).default(4),
  maxExposureUsd: z.coerce.number().positive().default(200),
  stagedEntry: z.boolean().default(true),
  anchorMinMcapUsd: z.coerce.number().nonnegative().default(100_000),
  anchorMaxMcapUsd: z.coerce.number().positive().default(250_000),
  entryMaxMcapUsd: z.coerce.number().positive().default(1_000_000),
  minVol1hUsd: z.coerce.number().nonnegative().default(60_000),
  surveillanceMinVol1hUsd: z.coerce.number().nonnegative().default(60_000),
  minAgeMin: z.coerce.number().nonnegative().default(720),
  maxAgeMin: z.coerce.number().nonnegative().default(2880),
  dumpMinPct: z.coerce.number().nonnegative().default(50),
  dumpMinMultiple: z.coerce.number().positive().default(3),
  clusterSellRatioMin: z.coerce.number().min(0).max(1).default(0.55),
  clusterMinUniqueSellers: z.coerce.number().int().min(1).max(10).default(3),
  retailPanicMax: z.coerce.number().min(0).max(1).default(0.45),
  minUniqueBuyers1h: z.coerce.number().int().nonnegative().default(25),
  maxClusterBuyerRatio: z.coerce.number().min(0).max(1).default(0.35),
  rerampMinFromBottomPct: z.coerce.number().nonnegative().default(35),
  rerampMaxVsPeakPct: z.coerce.number().min(0).max(1).default(0.85),
  watchTtlHours: z.coerce.number().positive().default(72),
  holderPollMin: z.coerce.number().int().positive().default(5),
  earlyBuyWindowSec: z.coerce.number().int().min(30).max(7200).default(180),
  phaseAPeakMcapUsd: z.coerce.number().positive().default(400_000),
  phaseAMinDwellHours: z.coerce.number().nonnegative().default(4),
  killPct: z.coerce.number().min(0.01).max(0.5).default(0.5),
  maxEntriesPerTick: z.coerce.number().int().min(1).default(1),
  organicGateEnabled: z.boolean().default(false),
  organicGateMode: PervyyVystrelModeSchema.default('shadow'),
  clusterDumpMode: PervyyVystrelModeSchema.default('shadow'),
  volAuthEnabled: z.boolean().default(false),
  volAuthMode: PervyyVystrelModeSchema.default('shadow'),
  volAuthWashMax: z.coerce.number().min(0).max(1).default(0.55),
  volAuthOrganicMin: z.coerce.number().min(0).max(1).default(0.45),
  volAuthMaxRoundTripShare: z.coerce.number().min(0).max(1).default(0.45),
  volAuthFailOpen: z.boolean().default(true),
  /** PR2 — volume authenticity window + sub-thresholds (spec §6.4.2). */
  volAuthWindowHours: z.coerce.number().positive().default(1),
  volAuthMinSwaps: z.coerce.number().int().nonnegative().default(20),
  volAuthMaxCycleShare: z.coerce.number().min(0).max(1).default(0.35),
  volAuthMinBsRatio: z.coerce.number().positive().default(1.15),
  volAuthMaxSelfTrade: z.coerce.number().min(0).max(1).default(0.25),
  volAuthMinNetNewShare: z.coerce.number().min(0).max(1).default(0.40),
  volAuthHolderStallPct: z.coerce.number().nonnegative().default(0.5),
  minUnclusteredBuyers1h: z.coerce.number().int().nonnegative().default(15),
  materializeEnabled: z.boolean().default(false),
  materializeIntervalMin: z.coerce.number().int().positive().default(15),
});

export type PervyyVystrelConfig = z.infer<typeof PervyyVystrelConfigSchema>;
export type PervyyVystrelMode = z.infer<typeof PervyyVystrelModeSchema>;

export function loadPervyyVystrelConfig(env: NodeJS.ProcessEnv = process.env): PervyyVystrelConfig {
  return PervyyVystrelConfigSchema.parse({
    enabled: envBool(env.PAPER_PERVYY_VYSTREL_ENABLED, false),
    mode: env.PAPER_PERVYY_VYSTREL_MODE,
    failOpen: envBool(env.PAPER_PERVYY_VYSTREL_FAIL_OPEN, true),
    legUsd: env.PAPER_PERVYY_VYSTREL_LEG_USD,
    positionUsd: env.PAPER_PERVYY_VYSTREL_POSITION_USD,
    maxConcurrent: env.PAPER_PERVYY_VYSTREL_MAX_CONCURRENT,
    maxExposureUsd: env.PAPER_PERVYY_VYSTREL_MAX_EXPOSURE_USD,
    stagedEntry: envBool(env.PAPER_PERVYY_VYSTREL_STAGED_ENTRY, true),
    anchorMinMcapUsd: env.PAPER_PERVYY_VYSTREL_ANCHOR_MIN_MCAP_USD,
    anchorMaxMcapUsd: env.PAPER_PERVYY_VYSTREL_ANCHOR_MAX_MCAP_USD,
    entryMaxMcapUsd: env.PAPER_PERVYY_VYSTREL_ENTRY_MAX_MCAP_USD,
    minVol1hUsd: env.PAPER_PERVYY_VYSTREL_MIN_VOL_1H_USD,
    surveillanceMinVol1hUsd: env.PAPER_PERVYY_VYSTREL_SURVEILLANCE_MIN_VOL_1H_USD,
    minAgeMin: env.PAPER_PERVYY_VYSTREL_MIN_AGE_MIN,
    maxAgeMin: env.PAPER_PERVYY_VYSTREL_MAX_AGE_MIN,
    dumpMinPct: env.PAPER_PERVYY_VYSTREL_DUMP_MIN_PCT,
    dumpMinMultiple: env.PAPER_PERVYY_VYSTREL_DUMP_MIN_MULTIPLE,
    clusterSellRatioMin: env.PAPER_PERVYY_VYSTREL_CLUSTER_SELL_RATIO_MIN,
    clusterMinUniqueSellers: env.PAPER_PERVYY_VYSTREL_CLUSTER_MIN_UNIQUE_SELLERS,
    retailPanicMax: env.PAPER_PERVYY_VYSTREL_RETAIL_PANIC_MAX,
    minUniqueBuyers1h: env.PAPER_PERVYY_VYSTREL_MIN_UNIQUE_BUYERS_1H,
    maxClusterBuyerRatio: env.PAPER_PERVYY_VYSTREL_MAX_CLUSTER_BUYER_RATIO,
    rerampMinFromBottomPct: env.PAPER_PERVYY_VYSTREL_RERAMP_MIN_FROM_BOTTOM_PCT,
    rerampMaxVsPeakPct: env.PAPER_PERVYY_VYSTREL_RERAMP_MAX_VS_PEAK_PCT,
    watchTtlHours: env.PAPER_PERVYY_VYSTREL_WATCH_TTL_HOURS,
    holderPollMin: env.PAPER_PERVYY_VYSTREL_HOLDER_POLL_MIN,
    earlyBuyWindowSec: env.PAPER_PERVYY_VYSTREL_EARLY_BUY_WINDOW_SEC,
    phaseAPeakMcapUsd: env.PAPER_PERVYY_VYSTREL_PHASE_A_PEAK_MCAP_USD,
    phaseAMinDwellHours: env.PAPER_PERVYY_VYSTREL_PHASE_A_MIN_DWELL_H,
    killPct: env.PAPER_PERVYY_VYSTREL_KILL_PCT,
    maxEntriesPerTick: env.PAPER_PERVYY_VYSTREL_MAX_ENTRIES_PER_TICK,
    organicGateEnabled: envBool(env.PAPER_PERVYY_VYSTREL_ORGANIC_GATE_ENABLED, false),
    organicGateMode: env.PAPER_PERVYY_VYSTREL_ORGANIC_GATE_MODE,
    clusterDumpMode: env.PAPER_PERVYY_VYSTREL_CLUSTER_DUMP_MODE,
    volAuthEnabled: envBool(env.PAPER_PERVYY_VYSTREL_VOL_AUTH_ENABLED, false),
    volAuthMode: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MODE,
    volAuthWashMax: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_WASH_MAX,
    volAuthOrganicMin: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_ORGANIC_MIN,
    volAuthMaxRoundTripShare: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_ROUND_TRIP_SHARE,
    volAuthFailOpen: envBool(env.PAPER_PERVYY_VYSTREL_VOL_AUTH_FAIL_OPEN, true),
    volAuthWindowHours: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_WINDOW_H,
    volAuthMinSwaps: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_SWAPS,
    volAuthMaxCycleShare: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_CYCLE_SHARE,
    volAuthMinBsRatio: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_BS_RATIO,
    volAuthMaxSelfTrade: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_SELF_TRADE,
    volAuthMinNetNewShare: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_NET_NEW_SHARE,
    volAuthHolderStallPct: env.PAPER_PERVYY_VYSTREL_VOL_AUTH_HOLDER_STALL_PCT,
    minUnclusteredBuyers1h: env.PAPER_PERVYY_VYSTREL_MIN_UNCLUSTERED_BUYERS_1H,
    materializeEnabled: envBool(env.PERVYY_VYSTREL_MATERIALIZE_ENABLED, false),
    materializeIntervalMin: env.PERVYY_VYSTREL_MATERIALIZE_INTERVAL_MIN,
  });
}

export function isPervyyVystrelLaneEnabled(
  strategyId: string,
  pv: Pick<PervyyVystrelConfig, 'enabled' | 'mode'>,
): boolean {
  return isLiveOscarTradingStrategyId(strategyId) && pv.enabled && pv.mode !== 'off';
}

/** PR1 ingest + shadow eval — mode ≠ off (includes ENABLED=0 shadow rollout). */
export function isPervyyVystrelObservabilityActive(
  strategyId: string,
  pv: Pick<PervyyVystrelConfig, 'enabled' | 'mode'>,
): boolean {
  if (!isLiveOscarTradingStrategyId(strategyId)) return false;
  if (pv.mode === 'off') return false;
  return pv.mode === 'shadow' || pv.enabled;
}

export function pervyyVystrelOpenMapKey(mint: string): string {
  return `${mint}${PERVYY_VYSTREL_OPEN_MAP_SUFFIX}`;
}
