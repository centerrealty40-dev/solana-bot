import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl, resolveSolanaRpcWsUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import type { PumpswapComboConfig } from '../pumpswap-combo/config.js';
import {
  effectiveExitLadder,
  effectiveStopLossPct,
  parseExitLadderSpec,
  type EffectiveExitRung,
  type ExitLadderRungSpec,
} from './exit-ladder.js';
import { parseFollowSlMode, type FollowSlMode } from './exit-policy.js';

export type FollowDcaAnchor = 'first' | 'avg';

export type FollowDcaLevel = {
  triggerPct: number;
  addFraction: number;
  anchor: FollowDcaAnchor;
};

/** DCA spec: `-8:0.333:first,-7:0.333:avg` (trigger %, add fraction, anchor). */
export function parseFollowDcaLevels(spec: string | undefined | null): FollowDcaLevel[] {
  if (!spec?.trim()) return [];
  const out: FollowDcaLevel[] = [];
  for (const part of spec.split(',')) {
    const seg = part.trim().split(':').map((s) => s.trim());
    if (seg.length < 2) continue;
    const trig = Number(seg[0]);
    const frac = Number(seg[1]);
    const anchor: FollowDcaAnchor = seg[2]?.toLowerCase() === 'avg' ? 'avg' : 'first';
    if (!Number.isFinite(trig) || !Number.isFinite(frac) || frac <= 0) continue;
    out.push({ triggerPct: trig / 100, addFraction: frac, anchor });
  }
  return out;
}

/** Default front-run DCA: buy before leader ~−10% / ~−8% avg-down adds. */
export const FLOW8Z_FRONTRUN_DCA_LEVELS = '-8:0.333333:first,-7:0.333333:avg';

export type FollowExitPolicy = 'leader_ladder' | 'oscar_wave_b' | 'flow8z_antidump';

export type FollowEntryGate = 'all' | 'flow';

function parseFollowEntryGate(raw: string | undefined, executionMode: string): FollowEntryGate {
  const v = raw?.trim().toLowerCase();
  if (v === 'flow') return 'flow';
  if (v === 'all' || v === 'none' || v === '0') return 'all';
  return executionMode === 'live' ? 'flow' : 'all';
}

function parseFollowExitPolicy(raw: string | undefined): FollowExitPolicy {
  const v = raw?.trim().toLowerCase();
  if (v === 'leader_ladder' || v === 'legacy') return 'leader_ladder';
  if (v === 'flow8z_antidump' || v === 'flow8z' || v === 'flow_mirror') return 'flow8z_antidump';
  return 'oscar_wave_b';
}

/** PumpSwap flow bot — mirror target (infra savings vs own discovery). */
export const FLOW8Z_TARGET_WALLET = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';

export const FLOW8Z_DEFAULT_EXIT_LADDER = '5:0.45,10:0.35,15:1';

/** Primary reference wallet (hnu5 PumpSwap dip bot). */
export const HNU5_TARGET_WALLET = 'hnu5iBK8UoHb51UFsH1RYTUAYdrhjHvV5YMTf9T1CYN';

const ExecutionModeSchema = z.enum(['paper', 'dry_run', 'live']);

const ConfigSchema = z.object({
  executionMode: ExecutionModeSchema,
  strategyId: z.string().min(1).default('pumpswap-combo-follow'),
  journalPath: z.string().min(1),
  statePath: z.string().min(1),
  rpcUrl: z.string().min(8),
  targetWallet: z.string().min(32).max(64),
  pollIntervalMs: z.coerce.number().int().min(2000).max(60_000).default(5000),
  heartbeatIntervalMs: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  signatureLimit: z.coerce.number().int().min(5).max(50).default(25),
  /** Mirror leader buy after N ms (0 = immediate). */
  buyDelayMs: z.coerce.number().int().min(0).max(300_000).default(0),
  buyRetryWindowMs: z.coerce.number().int().min(0).max(3_600_000).default(600_000),
  minLeaderBuyUsd: z.coerce.number().min(0).default(20),
  /** Skip mirror entry when leader first buy exceeds this (0 = off). */
  maxLeaderFirstBuyUsd: z.coerce.number().min(0).default(0),
  maxOpenPositions: z.coerce.number().int().min(0).max(100).default(0),
  legUsd: z.coerce.number().positive().max(500).default(3),
  dcaLevelsRaw: z.string().default(''),
  dcaKillstopPct: z.coerce.number().min(0).max(90).default(50),
  /** leader_ladder | oscar_wave_b | flow8z_antidump */
  exitPolicy: z.enum(['leader_ladder', 'oscar_wave_b', 'flow8z_antidump']).default('oscar_wave_b'),
  mirrorLeaderAdds: z.coerce.boolean().default(false),
  waveBTrailSellFraction: z.coerce.number().min(0.05).max(1).default(0.2),
  maxBuyLegs: z.coerce.number().int().min(1).max(5).default(3),
  /** TP rungs fire this many % before leader thresholds. */
  exitLeadPct: z.coerce.number().min(0).max(10).default(2),
  exitLadderRaw: z.string().default(''),
  /** Leader forensic SL — we exit tighter by exitLeadPct. Wider while DCA legs remain. */
  slSingleLegPct: z.coerce.number().min(1).max(90).default(20),
  slMultiLegPct: z.coerce.number().min(1).max(90).default(22),
  slPreDcaPct: z.coerce.number().min(1).max(90).default(35),
  /** fixed | while_leader_holds_off | after_leader_sell */
  slMode: z.enum(['fixed', 'while_leader_holds_off', 'after_leader_sell']).default('while_leader_holds_off'),
  portfolioStopLossUsd: z.coerce.number().positive().default(50),
  lossCooldownMs: z.coerce.number().int().min(0).default(600_000),
  lossAlertUsd: z.coerce.number().positive().default(5),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(300),
  /** logsSubscribe on leader wallet (QuickNode/Helius wss) — instant detect vs HTTP poll. */
  leaderWsEnabled: z.coerce.boolean().default(false),
  leaderWsUrl: z.string().optional(),
  /** HTTP poll backfill when leader WS is on (ms). */
  pollFallbackMs: z.coerce.number().int().min(5000).max(300_000).default(30_000),
  /** all = mirror every entry; flow = skip chase (no large ext sell before leader buy). */
  entryGate: z.enum(['all', 'flow']).default('all'),
  flowGateMinExtSellUsd: z.coerce.number().min(0).default(300),
  /** 0 = no upper cap on triggering sell size. */
  flowGateMaxExtSellUsd: z.coerce.number().min(0).default(2500),
  flowGateLookbackSec: z.coerce.number().int().min(5).max(600).default(120),
  /** 0 = do not filter by sell→buy lag (seconds). */
  flowGateMaxLagSec: z.coerce.number().int().min(0).max(120).default(0),
  flowGatePoolTxCap: z.coerce.number().int().min(5).max(80).default(35),
  /** Force exit remainder after N ms (0 = off). Follow v2: 3h cap on bagholding. */
  maxHoldMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
  /** flow8z_antidump: fixed killstop (% loss vs avg fill). 0 = off (backtest: tight killstop hurts on sparse marks). */
  flow8zKillstopPct: z.coerce.number().min(0).max(90).default(0),
  /** flow8z_antidump: flush at pool quote when leader sells while we still hold. */
  flow8zLeaderFlushEnabled: z.coerce.boolean().default(true),
  /** flow8z: ms to wait after leader sell before pool flush (TP still active). 0 = immediate. */
  flow8zLeaderSellDelayMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
  walletSecret: z.string().optional(),
  walletPubkeyExpected: z.string().min(32).max(64).optional(),
});

export type PumpswapComboFollowConfig = z.infer<typeof ConfigSchema> & {
  exitLadderSpec: ExitLadderRungSpec[];
  exitLadder: EffectiveExitRung[];
  slMode: FollowSlMode;
  dcaLevels: FollowDcaLevel[];
  /** Entry mirror size — always legUsd ($3 test agent). */
  entryUsd: number;
  /** DCA add sizing base: legUsd × addFraction (Oscar % ladder on our notional). */
  dcaNotionalUsd: number;
};

/** Map to pumpswap-combo executor / journal (unused discovery fields filled with dummies). */
export function toComboExecutorConfig(cfg: PumpswapComboFollowConfig): PumpswapComboConfig {
  const first = cfg.exitLadder[0];
  const last = cfg.exitLadder[cfg.exitLadder.length - 1];
  return {
    strategyId: cfg.strategyId,
    journalPath: cfg.journalPath,
    statePath: cfg.statePath,
    rpcUrl: cfg.rpcUrl,
    pollIntervalMs: cfg.pollIntervalMs,
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    rpcMinGapMs: 55,
    meteredRpcEnabled: false,
    balanceCacheTtlMs: 10_000,
    exitMarkTtlMs: 20_000,
    exitMarkMaxStaleMs: 45_000,
    exitQuotesPerTick: 2,
    watchlistStreamPreferPg: false,
    watchlistStreamFreshMs: 120_000,
    watchlistMax: 1,
    watchlistPgLookbackMin: 360,
    watchlistRpcRefreshEnabled: false,
    watchlistRpcRefreshPerTick: 1,
    watchlistRpcRefreshDelayMs: 80,
    minLiquidityUsd: 0,
    minVolume5mUsd: 0,
    minMarketCapUsd: 0,
    maxMarketCapUsd: 0,
    rollingHighWindowMs: 900_000,
    dumpMinPct: 0,
    dumpMaxPct: 100,
    dumpFreshnessMs: 900_000,
    probeMaxDipFromPeakPct: 100,
    addDipMinPct: 0,
    addDipMaxPct: 100,
    maxBuyLegs: cfg.maxBuyLegs,
    addMinGapMs: 0,
    legUsd: cfg.entryUsd,
    tp1Pct: first?.effectiveTpPct ?? 11,
    tp1SellFrac: first?.sellFracOfRemaining ?? 0.7,
    tp2Pct: last?.effectiveTpPct ?? 23,
    slSingleLegPct: effectiveStopLossPct(cfg.slSingleLegPct, cfg.exitLeadPct, false, cfg.slMultiLegPct),
    slMultiLegPct: effectiveStopLossPct(cfg.slSingleLegPct, cfg.exitLeadPct, true, cfg.slMultiLegPct),
    slPreDcaPct: cfg.slPreDcaPct,
    portfolioStopLossUsd: cfg.portfolioStopLossUsd,
    lossCooldownMs: cfg.lossCooldownMs,
    lossAlertUsd: cfg.lossAlertUsd,
    slippageBps: cfg.slippageBps,
    maxConcurrentOpens: 20,
    walletSecret: cfg.walletSecret,
    walletPubkeyExpected: cfg.walletPubkeyExpected,
  };
}

export function loadPumpswapComboFollowConfig(): PumpswapComboFollowConfig {
  const root = process.cwd();
  const journalPath =
    process.env.PUMPSWAP_COMBO_FOLLOW_JOURNAL_PATH?.trim() ||
    path.join(root, 'data/pumpswap-combo-follow/journal.jsonl');
  const statePath =
    process.env.PUMPSWAP_COMBO_FOLLOW_STATE_PATH?.trim() ||
    path.join(root, 'data/pumpswap-combo-follow/state.json');
  const rpcUrl =
    process.env.PUMPSWAP_COMBO_FOLLOW_RPC_URL?.trim() ||
    liveOscarRpcHttpUrlFromEnv() ||
    resolveSolanaRpcUrl() ||
    '';

  const executionMode =
    (process.env.PUMPSWAP_COMBO_FOLLOW_EXECUTION_MODE?.trim() as z.infer<
      typeof ExecutionModeSchema
    >) || 'paper';

  const walletSecret = process.env.PUMPSWAP_COMBO_FOLLOW_WALLET_SECRET?.trim();
  if (executionMode === 'live') {
    if (!walletSecret || !fs.existsSync(walletSecret)) {
      throw new Error(
        `PUMPSWAP_COMBO_FOLLOW_WALLET_SECRET missing or file not found (${walletSecret ?? 'unset'}) — required for live`,
      );
    }
  }

  const exitPolicy = parseFollowExitPolicy(process.env.PUMPSWAP_COMBO_FOLLOW_EXIT_POLICY);
  const isFlow8z = exitPolicy === 'flow8z_antidump';

  const exitLadderRaw =
    process.env.PUMPSWAP_COMBO_FOLLOW_EXIT_LADDER?.trim() ||
    (isFlow8z ? FLOW8Z_DEFAULT_EXIT_LADDER : '');
  const exitLeadPct = Number(
    process.env.PUMPSWAP_COMBO_FOLLOW_EXIT_LEAD_PCT ?? (isFlow8z ? '0' : '2'),
  );
  const exitLadderSpec = parseExitLadderSpec(exitLadderRaw);
  const exitLadder = effectiveExitLadder(exitLadderSpec, exitLeadPct);

  const dcaLevelsRaw =
    process.env.PUMPSWAP_COMBO_FOLLOW_DCA_LEVELS?.trim() ||
    (exitPolicy === 'oscar_wave_b'
      ? '-10:0.333333,-20:0.333333'
      : isFlow8z
        ? FLOW8Z_FRONTRUN_DCA_LEVELS
        : '');
  const dcaLevels = parseFollowDcaLevels(dcaLevelsRaw);
  const mirrorLeaderAddsRaw = process.env.PUMPSWAP_COMBO_FOLLOW_MIRROR_LEADER_ADDS?.trim();
  const mirrorLeaderAdds =
    mirrorLeaderAddsRaw != null && mirrorLeaderAddsRaw.length > 0
      ? mirrorLeaderAddsRaw === '1' || mirrorLeaderAddsRaw.toLowerCase() === 'true'
      : exitPolicy === 'leader_ladder';

  const entryGate = parseFollowEntryGate(
    process.env.PUMPSWAP_COMBO_FOLLOW_ENTRY_GATE ?? (isFlow8z ? 'flow' : undefined),
    executionMode,
  );
  const leaderWsRaw = process.env.PUMPSWAP_COMBO_FOLLOW_LEADER_WS?.trim();
  const leaderWsUrl =
    process.env.PUMPSWAP_COMBO_FOLLOW_LEADER_WS_URL?.trim() || resolveSolanaRpcWsUrl() || undefined;
  const leaderWsRequested =
    leaderWsRaw != null && leaderWsRaw.length > 0
      ? leaderWsRaw === '1' || leaderWsRaw.toLowerCase() === 'true'
      : executionMode === 'live' || isFlow8z;
  const leaderWsEnabled = leaderWsRequested && Boolean(leaderWsUrl);

  const parsed = ConfigSchema.parse({
    executionMode,
    strategyId: process.env.PUMPSWAP_COMBO_FOLLOW_STRATEGY_ID ?? 'pumpswap-combo-follow',
    journalPath,
    statePath,
    rpcUrl,
    targetWallet: process.env.PUMPSWAP_COMBO_FOLLOW_TARGET_WALLET?.trim() || HNU5_TARGET_WALLET,
    pollIntervalMs: process.env.PUMPSWAP_COMBO_FOLLOW_POLL_MS,
    heartbeatIntervalMs: process.env.PUMPSWAP_COMBO_FOLLOW_HEARTBEAT_MS,
    signatureLimit: process.env.PUMPSWAP_COMBO_FOLLOW_SIGNATURE_LIMIT,
    buyDelayMs: process.env.PUMPSWAP_COMBO_FOLLOW_BUY_DELAY_MS,
    buyRetryWindowMs: process.env.PUMPSWAP_COMBO_FOLLOW_BUY_RETRY_MS,
    minLeaderBuyUsd:
      process.env.PUMPSWAP_COMBO_FOLLOW_MIN_LEADER_BUY_USD ?? (isFlow8z ? '150' : undefined),
    maxLeaderFirstBuyUsd: process.env.PUMPSWAP_COMBO_FOLLOW_MAX_LEADER_FIRST_BUY_USD ?? (isFlow8z ? '0' : undefined),
    maxOpenPositions:
      process.env.PUMPSWAP_COMBO_FOLLOW_MAX_OPEN ??
      (isFlow8z || (executionMode === 'live' && entryGate === 'flow') ? '8' : undefined),
    legUsd: process.env.PUMPSWAP_COMBO_FOLLOW_LEG_USD,
    dcaLevelsRaw,
    dcaKillstopPct: process.env.PUMPSWAP_COMBO_FOLLOW_DCA_KILLSTOP_PCT,
    exitPolicy,
    mirrorLeaderAdds,
    waveBTrailSellFraction: process.env.PUMPSWAP_COMBO_FOLLOW_WAVE_B_TRAIL_SELL_FRACTION,
    maxBuyLegs:
      process.env.PUMPSWAP_COMBO_FOLLOW_MAX_BUY_LEGS ??
      (exitPolicy === 'oscar_wave_b' || isFlow8z ? String(1 + dcaLevels.length) : undefined),
    exitLeadPct,
    exitLadderRaw,
    slSingleLegPct: process.env.PUMPSWAP_COMBO_FOLLOW_SL_SINGLE_PCT,
    slMultiLegPct: process.env.PUMPSWAP_COMBO_FOLLOW_SL_MULTI_PCT,
    slPreDcaPct: process.env.PUMPSWAP_COMBO_FOLLOW_SL_PRE_DCA_PCT,
    slMode: parseFollowSlMode(process.env.PUMPSWAP_COMBO_FOLLOW_SL_MODE),
    portfolioStopLossUsd:
      process.env.PUMPSWAP_COMBO_FOLLOW_PORTFOLIO_STOP_LOSS_USD ?? (isFlow8z ? '35' : undefined),
    lossCooldownMs: process.env.PUMPSWAP_COMBO_FOLLOW_LOSS_COOLDOWN_MS,
    lossAlertUsd: process.env.PUMPSWAP_COMBO_FOLLOW_LOSS_ALERT_USD,
    slippageBps: process.env.PUMPSWAP_COMBO_FOLLOW_SLIPPAGE_BPS ?? (isFlow8z ? '100' : undefined),
    leaderWsEnabled,
    leaderWsUrl,
    pollFallbackMs: process.env.PUMPSWAP_COMBO_FOLLOW_POLL_FALLBACK_MS,
    entryGate,
    flowGateMinExtSellUsd: process.env.PUMPSWAP_COMBO_FOLLOW_FLOW_MIN_EXT_SELL_USD,
    flowGateMaxExtSellUsd: process.env.PUMPSWAP_COMBO_FOLLOW_FLOW_MAX_EXT_SELL_USD,
    flowGateLookbackSec: process.env.PUMPSWAP_COMBO_FOLLOW_FLOW_LOOKBACK_SEC,
    flowGateMaxLagSec:
      process.env.PUMPSWAP_COMBO_FOLLOW_FLOW_MAX_LAG_SEC ??
      (entryGate === 'flow' && isFlow8z ? '5' : undefined),
    flowGatePoolTxCap: process.env.PUMPSWAP_COMBO_FOLLOW_FLOW_POOL_TX_CAP,
    maxHoldMs:
      process.env.PUMPSWAP_COMBO_FOLLOW_MAX_HOLD_MS ??
      (isFlow8z ? String(3 * 3600 * 1000) : undefined),
    flow8zKillstopPct: process.env.PUMPSWAP_COMBO_FOLLOW_FLOW8Z_KILLSTOP_PCT,
    flow8zLeaderFlushEnabled: process.env.PUMPSWAP_COMBO_FOLLOW_FLOW8Z_LEADER_FLUSH,
    flow8zLeaderSellDelayMs:
      process.env.PUMPSWAP_COMBO_FOLLOW_FLOW8Z_LEADER_SELL_DELAY_MS ??
      (isFlow8z ? '60000' : undefined),
    walletSecret,
    walletPubkeyExpected: process.env.PUMPSWAP_COMBO_FOLLOW_WALLET_PUBKEY?.trim(),
  });

  const entryUsd = parsed.legUsd;
  const dcaNotionalRaw = process.env.PUMPSWAP_COMBO_FOLLOW_DCA_NOTIONAL_USD?.trim();
  const dcaNotionalUsd =
    dcaNotionalRaw && Number(dcaNotionalRaw) > 0 ? Number(dcaNotionalRaw) : parsed.legUsd;

  return {
    ...parsed,
    exitLadderSpec,
    exitLadder,
    dcaLevels,
    entryUsd,
    dcaNotionalUsd,
  };
}
