/**
 * Knife-catcher — standalone worker (isolated; NOT wired into live-oscar).
 *
 * Event-driven whale-dump entry: detect large sell swaps that print a fast dump from a recent local
 * high, enter the dip within a short window, scalp out on an infinite Oscar-style TP grid
 * (break-even + ladder-retrace + peak trail).
 *
 * Price path: Jupiter buy-quote (trusted anchor) + stream swap_decode only when it agrees
 * with fresh Jupiter and passes tick-move guards. Raw stream prices never reach buffer/PnL.
 *
 * ISOLATION CONTRACT:
 *  - Own PM2 process. Never imported by live-oscar / papertrader hot path.
 *  - Own Shyft Yellowstone gRPC consumer over a SMALL, slowly-changing mint set (≤ topN).
 *  - Read-only on Postgres (watchlist ranking). Writes only its own JSONL journal.
 *  - `KNIFE_MODE=shadow` (default) journals hypothetical fills and never executes.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { child } from '../core/logger.js';
import { getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';
import { setShyftShadowWatchedMints } from '../papertrader/stream/shadow-state.js';
import {
  startShyftShadowConsumer,
  type ShyftObservationMeta,
} from '../papertrader/stream/shyft-shadow-consumer.js';
import {
  buildKnifeAvgTelegram,
  buildKnifeCloseTelegram,
  buildKnifeDumpTelegram,
  buildKnifeEntryTelegram,
  buildKnifeSummaryTelegram,
} from './knife-telegram-format.js';
import {
  getKnifeTrustedPrice,
  isKnifeExitPriceSane,
  isKnifeTpTickSane,
  startKnifeJupiterPoll,
  tryAdoptKnifeSwapPrice,
  type KnifePriceSource,
} from './knife-price-feed.js';
import {
  buildKnifeGuardPaperCfg,
  cacheKnifeAnalyticsVerdict,
  filterKnifeWatchlist,
  getCachedKnifeAnalyticsVerdict,
  isKnifeEntryAllowed,
  loadKnifeAnalyticsConfig,
  type KnifeAnalyticsConfig,
} from './knife-analytics-gate.js';
import { sendTagged } from '../core/telegram/sender.js';
import { detectRollingFlush } from './knife-flush-detector.js';
import { evaluateKnifeFlushLeg2 } from './knife-flush-leg2.js';
import { knifeWatchdogVerdict } from './knife-watchdog.js';
import {
  defaultKnifeExitLadderConfig,
  knifePnlPct,
  ladderRetraceTriggered,
  markRungFired,
  newlyReachableRungs,
  nextGridRungPnl,
  peakTrailTriggered,
  sellFracForRungIndex,
  updatePeakTrailArm,
  type KnifeExitLadderConfig,
} from './knife-exit-ladder.js';
import {
  fetchKnifeLatestVolumeUsd,
  loadKnifeVolDecayConfig,
  recordVolDeclineSample,
  volDecayExitTriggered,
  type KnifeVolDecayConfig,
  type VolMinuteSample,
} from './knife-vol-decay-exit.js';

const log = child('knife-catcher');
const EPS = 1e-12;

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function envNum(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

interface KnifeConfig {
  enabled: boolean;
  mode: 'shadow' | 'live';
  /**
   * Stage-1 on-chain data collection. When true: run watchlist + Shyft swap_decode consumer and
   * persist every observed swap (with trader wallet) to `swapCapturePath`, but SKIP the Jupiter
   * poll and all dump/entry/exit logic. All new runtime load stays on Shyft — no Jupiter, no
   * DexScreener, no Discovery snapshot writes.
   */
  captureOnly: boolean;
  /** Persist observed Shyft swaps (mint/wallet/side/usd/price) to a JSONL for offline cluster join. */
  swapCaptureEnabled: boolean;
  swapCapturePath: string;
  topN: number;
  watchlistRefreshMs: number;
  watchlistLookbackMin: number;
  minVol1hUsd: number;
  bufferMs: number;
  minDumpPct: number;
  minSellUsd: number;
  maxEntryAfterDumpMs: number;
  preDumpHighMs: number;
  /** Price-based rolling-flush trigger — fires on distributed/gradual flushes without a single whale sell. */
  flushTriggerEnabled: boolean;
  flushWindowMs: number;
  flushMinDumpPct: number;
  maxBounceFromDumpPct: number;
  maxDrawdownPct: number;
  globalEntryGapMs: number;
  minObs: number;
  watchlistWarmupMs: number;
  crossSourceMaxPct: number;
  maxTickMovePct: number;
  maxExitMovePct: number;
  maxTpTickMovePct: number;
  minHoldBeforeTpMs: number;
  legUsd: number;
  positionUsd: number;
  /** Second leg (avg-down) — off by default for knife scalp. */
  avgLegEnabled: boolean;
  avgDropPct: number;
  /** Leg2 on new floor flush while leg1 open (independent of avgLegEnabled). */
  flushLeg2Enabled: boolean;
  flushLeg2MinDumpPct: number;
  exitLadder: KnifeExitLadderConfig;
  maxHoldMs: number;
  cooldownMs: number;
  telegramEnabled: boolean;
  summaryMs: number;
  /** Self-watchdog: force clean exit(1) before a memory leak reaches kernel OOM (which threatens the whole VPS). */
  watchdogRssMb: number;
  watchdogStallMs: number;
  watchdogCheckMs: number;
  journalPath: string;
  shyftEndpoint: string;
  shyftToken: string;
  jupiterPollIntervalMs: number;
  jupiterSlippageBps: number;
  jupiterTimeoutMs: number;
  jupiterMaxMintsPerTick: number;
  volDecay: KnifeVolDecayConfig;
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): KnifeConfig {
  const legUsd = envNum(env.KNIFE_LEG_USD, 250);
  const positionUsd = envNum(env.KNIFE_POSITION_USD, 250);
  return {
    enabled: envBool(env.KNIFE_CATCHER_ENABLED, false),
    mode: String(env.KNIFE_MODE ?? 'shadow').trim().toLowerCase() === 'live' ? 'live' : 'shadow',
    captureOnly: envBool(env.KNIFE_CAPTURE_ONLY, false),
    swapCaptureEnabled: envBool(env.KNIFE_SWAP_CAPTURE_ENABLED, true),
    swapCapturePath:
      env.KNIFE_SWAP_CAPTURE_PATH?.trim() ||
      path.join('data', 'knife-catcher', 'knife-swaps.jsonl'),
    topN: Math.min(64, Math.round(envNum(env.KNIFE_TOP_N, 15))),
    watchlistRefreshMs: Math.round(envNum(env.KNIFE_WATCHLIST_REFRESH_MIN, 3) * 60_000),
    watchlistLookbackMin: envNum(env.KNIFE_WATCHLIST_LOOKBACK_MIN, 30),
    minVol1hUsd: envNum(env.KNIFE_MIN_VOL_1H_USD, 50_000),
    bufferMs: Math.round(envNum(env.KNIFE_BUFFER_SEC, 300) * 1000),
    minDumpPct: envNum(env.KNIFE_MIN_DUMP_PCT, 10),
    minSellUsd: envNum(env.KNIFE_MIN_SELL_USD, 1500),
    maxEntryAfterDumpMs: Math.round(envNum(env.KNIFE_MAX_ENTRY_AFTER_DUMP_SEC, 50) * 1000),
    preDumpHighMs: Math.round(envNum(env.KNIFE_PRE_DUMP_HIGH_SEC, 600) * 1000),
    flushTriggerEnabled: envBool(env.KNIFE_FLUSH_TRIGGER_ENABLED, true),
    flushWindowMs: Math.round(envNum(env.KNIFE_FLUSH_WINDOW_SEC, 600) * 1000),
    flushMinDumpPct: envNum(env.KNIFE_FLUSH_MIN_DUMP_PCT, 10),
    maxBounceFromDumpPct: envNum(env.KNIFE_MAX_BOUNCE_FROM_DUMP_PCT, 5),
    maxDrawdownPct: envNum(env.KNIFE_MAX_DRAWDOWN_PCT, 40),
    globalEntryGapMs: Math.round(envNum(env.KNIFE_GLOBAL_ENTRY_GAP_SEC, 45) * 1000),
    minObs: Math.round(Number(env.KNIFE_MIN_OBS ?? 3)),
    watchlistWarmupMs: Math.round(envNum(env.KNIFE_WATCHLIST_WARMUP_SEC, 25) * 1000),
    crossSourceMaxPct: envNum(env.KNIFE_CROSS_SOURCE_MAX_PCT, 25),
    maxTickMovePct: envNum(env.KNIFE_MAX_TICK_MOVE_PCT, 25),
    maxExitMovePct: envNum(env.KNIFE_MAX_EXIT_MOVE_PCT, 15),
    maxTpTickMovePct: envNum(env.KNIFE_MAX_TP_TICK_MOVE_PCT, 6),
    minHoldBeforeTpMs: Math.round(envNum(env.KNIFE_MIN_HOLD_BEFORE_TP_SEC, 20) * 1000),
    legUsd,
    positionUsd,
    avgLegEnabled: envBool(env.KNIFE_AVG_LEG_ENABLED, false),
    avgDropPct: envNum(env.KNIFE_AVG_DROP_PCT, 8),
    flushLeg2Enabled: envBool(env.KNIFE_FLUSH_LEG2_ENABLED, true),
    flushLeg2MinDumpPct: envNum(env.KNIFE_FLUSH_LEG2_MIN_DUMP_PCT, 15),
    exitLadder: defaultKnifeExitLadderConfig(env),
    maxHoldMs: Math.round(Number(env.KNIFE_MAX_HOLD_SEC ?? 2700) * 1000) || 0,
    cooldownMs: Math.round(envNum(env.KNIFE_COOLDOWN_SEC, 600) * 1000),
    telegramEnabled: envBool(env.KNIFE_TELEGRAM_ENABLED, true),
    summaryMs: Math.round(envNum(env.KNIFE_SUMMARY_MIN, 30) * 60_000),
    watchdogRssMb: envNum(env.KNIFE_WATCHDOG_RSS_MB, 420),
    watchdogStallMs: Math.round(envNum(env.KNIFE_WATCHDOG_STALL_SEC, 600) * 1000),
    watchdogCheckMs: Math.round(envNum(env.KNIFE_WATCHDOG_CHECK_SEC, 15) * 1000),
    journalPath:
      env.KNIFE_CATCHER_JOURNAL_PATH?.trim() ||
      path.join('data', 'knife-catcher', 'knife-catcher.jsonl'),
    shyftEndpoint: env.SHYFT_GRPC_ENDPOINT?.trim() || 'https://grpc.fra.shyft.to',
    shyftToken: env.SHYFT_GRPC_TOKEN?.trim() ?? '',
    jupiterPollIntervalMs: Math.round(envNum(env.KNIFE_JUPITER_POLL_SEC, 2) * 1000),
    jupiterSlippageBps: Math.round(Number(env.KNIFE_JUPITER_SLIPPAGE_BPS ?? 300)),
    jupiterTimeoutMs: Math.round(envNum(env.KNIFE_JUPITER_TIMEOUT_SEC, 8) * 1000),
    jupiterMaxMintsPerTick: Math.round(envNum(env.KNIFE_JUPITER_MAX_MINTS_PER_TICK, 15)),
    volDecay: loadKnifeVolDecayConfig(env),
  };
}

type Phase = 'idle' | 'in_pos';

interface PricePoint {
  t: number;
  p: number;
}

export interface PendingWhaleDump {
  detectedAtMs: number;
  preDumpHigh: number;
  dumpLow: number;
  dumpPct: number;
  sellUsd: number;
  signature: string;
  source: string;
}

interface MintState {
  mint: string;
  buf: PricePoint[];
  phase: Phase;
  obsCount: number;
  cooldownUntilMs: number;
  watchlistJoinedAtMs: number;
  pendingDump: PendingWhaleDump | null;
  legs: number;
  leg1Price: number;
  entryTs: number;
  qtyFilled: number;
  qty: number;
  avgEntry: number;
  investedUsd: number;
  realizedUsd: number;
  peak: number;
  /** Sorted PnL% thresholds for grid rungs already sold (e.g. [5, 10]). */
  ladderFiredPnls: number[];
  peakPnlPct: number;
  trailArmed: boolean;
  lastMarkPrice: number;
  totalSoldQty: number;
  totalProceedsUsd: number;
  sellSummary: Array<{ reason: string; price: number; qty: number }>;
  /** Minute-bucket vol samples while in position (PG vol1h/vol5m). */
  volSamples: VolMinuteSample[];
}

const states = new Map<string, MintState>();
let journalPathResolved: string | null = null;
let globalLastEntryAtMs = 0;
/** Last time any price/swap observation was processed — fuels the stall watchdog. */
let lastActivityAtMs = Date.now();
let knifeAnalyticsCfg: KnifeAnalyticsConfig = loadKnifeAnalyticsConfig();

function appendJournal(cfg: KnifeConfig, ev: Record<string, unknown>): void {
  try {
    if (!journalPathResolved) {
      const dir = path.dirname(cfg.journalPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      journalPathResolved = cfg.journalPath;
    }
    fs.appendFileSync(
      journalPathResolved,
      `${JSON.stringify({ ts: Date.now(), mode: cfg.mode, ...ev })}\n`,
      'utf8',
    );
  } catch (e) {
    log.debug({ err: (e as Error).message }, 'journal append failed');
  }
}

let swapCapturePathResolved: string | null = null;
let swapCaptureCount = 0;

/**
 * Append one observed swap (with trader wallet) to the swap-capture JSONL.
 * Pure local disk write — no DB / DexScreener / Discovery load. Offline enrichment (cluster/tag
 * join against `wallet_tags` / `entity_wallets`) runs separately, read-only.
 */
function recordKnifeSwap(cfg: KnifeConfig, mint: string, tsMs: number, meta: ShyftObservationMeta): void {
  if (!cfg.swapCaptureEnabled) return;
  const wallet = meta.wallet?.trim();
  if (!wallet) return;
  try {
    if (!swapCapturePathResolved) {
      const dir = path.dirname(cfg.swapCapturePath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      swapCapturePathResolved = cfg.swapCapturePath;
    }
    fs.appendFileSync(
      swapCapturePathResolved,
      `${JSON.stringify({
        ts: tsMs,
        mint,
        wallet,
        side: meta.side,
        amountUsd: Number(meta.amountUsd.toFixed(2)),
        dex: meta.source,
        sig: meta.signature,
      })}\n`,
      'utf8',
    );
    swapCaptureCount += 1;
  } catch (e) {
    log.debug({ err: (e as Error).message }, 'swap capture append failed');
  }
}

function notifyHtml(cfg: KnifeConfig, html: string): void {
  if (!cfg.telegramEnabled) return;
  const subtag = cfg.mode === 'shadow' ? 'knife_shadow' : 'knife_live';
  const token =
    process.env.KNIFE_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat =
    process.env.KNIFE_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim();
  void sendTagged('REPORT', subtag, html, {
    parseMode: 'HTML',
    skipQuietHours: true,
    ...(token && chat ? { telegramBotToken: token, telegramChatId: chat } : {}),
  }).catch(() => false);
}

function getOrCreateState(mint: string): MintState {
  let s = states.get(mint);
  if (!s) {
    s = {
      mint,
      buf: [],
      phase: 'idle',
      obsCount: 0,
      cooldownUntilMs: 0,
      watchlistJoinedAtMs: Date.now(),
      pendingDump: null,
      legs: 0,
      leg1Price: 0,
      entryTs: 0,
      qtyFilled: 0,
      qty: 0,
      avgEntry: 0,
      investedUsd: 0,
      realizedUsd: 0,
      peak: 0,
      ladderFiredPnls: [],
      peakPnlPct: 0,
      trailArmed: false,
      lastMarkPrice: 0,
      totalSoldQty: 0,
      totalProceedsUsd: 0,
      sellSummary: [],
      volSamples: [],
    };
    states.set(mint, s);
  }
  return s;
}

/** Highest price within the last `windowMs`. */
function recentHigh(buf: PricePoint[], nowMs: number, windowMs: number): number {
  let hi = 0;
  const cutoff = nowMs - windowMs;
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    const pt = buf[i]!;
    if (pt.t < cutoff) break;
    if (pt.p > hi) hi = pt.p;
  }
  return hi;
}

function fillLeg(s: MintState, legUsd: number, price: number): void {
  const qtyLeg = legUsd / price;
  s.qtyFilled += qtyLeg;
  s.qty += qtyLeg;
  s.investedUsd += legUsd;
  s.legs += 1;
  s.avgEntry = s.investedUsd / s.qtyFilled;
}

function closePosition(cfg: KnifeConfig, s: MintState, nowMs: number, reason: string): void {
  const exitVwap = s.totalSoldQty > 0 ? s.totalProceedsUsd / s.totalSoldQty : s.lastMarkPrice;
  const holdSec = s.entryTs > 0 ? (nowMs - s.entryTs) / 1000 : 0;
  appendJournal(cfg, {
    kind: 'knife_close',
    mint: s.mint,
    reason,
    legs: s.legs,
    avgEntry: s.avgEntry,
    exitVwap,
    holdSec: Number(holdSec.toFixed(1)),
    investedUsd: Number(s.investedUsd.toFixed(2)),
    realizedUsd: Number(s.realizedUsd.toFixed(2)),
    totalPnlPct:
      s.investedUsd > 0 ? Number(((s.realizedUsd / s.investedUsd) * 100).toFixed(3)) : 0,
    sells: s.sellSummary,
  });
  const pnlPct = s.investedUsd > 0 ? (s.realizedUsd / s.investedUsd) * 100 : 0;
  notifyHtml(
    cfg,
    buildKnifeCloseTelegram({
      mode: cfg.mode,
      mint: s.mint,
      reason,
      legs: s.legs,
      avgEntry: s.avgEntry,
      exitVwap,
      holdSec,
      investedUsd: s.investedUsd,
      realizedUsd: s.realizedUsd,
      pnlPct,
      sells: s.sellSummary,
    }),
  );
  log.info(
    { mint: s.mint, reason, pnlUsd: Number(s.realizedUsd.toFixed(2)) },
    'knife position closed',
  );
  s.phase = 'idle';
  s.cooldownUntilMs = nowMs + cfg.cooldownMs;
  s.pendingDump = null;
  s.legs = 0;
  s.leg1Price = 0;
  s.entryTs = 0;
  s.qtyFilled = 0;
  s.qty = 0;
  s.avgEntry = 0;
  s.investedUsd = 0;
  s.realizedUsd = 0;
  s.peak = 0;
  s.ladderFiredPnls = [];
  s.peakPnlPct = 0;
  s.trailArmed = false;
  s.lastMarkPrice = 0;
  s.totalSoldQty = 0;
  s.totalProceedsUsd = 0;
  s.sellSummary = [];
  s.volSamples = [];
}

function tryVolDecayExit(
  cfg: KnifeConfig,
  s: MintState,
  price: number,
  tsMs: number,
): boolean {
  if (!cfg.volDecay.enabled || s.phase !== 'in_pos' || s.qty <= EPS) return false;
  if (!volDecayExitTriggered(s.volSamples, cfg.volDecay.consecutiveMin)) return false;

  const latestVolUsd = s.volSamples.length >= 1 ? s.volSamples[s.volSamples.length - 1]!.volUsd : 0;
  const priorVolUsd = s.volSamples.length >= 2 ? s.volSamples[s.volSamples.length - 2]!.volUsd : 0;
  appendJournal(cfg, {
    kind: 'knife_vol_decay_exit',
    mint: s.mint,
    metric: cfg.volDecay.metric,
    consecutiveMin: cfg.volDecay.consecutiveMin,
    declineMinutes: cfg.volDecay.consecutiveMin,
    latestVolUsd,
    priorVolUsd,
    pnlPct: Number(knifePnlPct(price, s.avgEntry).toFixed(2)),
  });
  sellAll(cfg, s, price, 'vol_decay');
  closePosition(cfg, s, tsMs, 'vol_decay');
  return true;
}

async function pollVolDecaySamples(cfg: KnifeConfig): Promise<void> {
  if (!cfg.volDecay.enabled) return;
  const now = Date.now();
  for (const s of states.values()) {
    if (s.phase !== 'in_pos') continue;
    try {
      const vol = await fetchKnifeLatestVolumeUsd(s.mint, cfg.volDecay.metric);
      if (vol == null) continue;
      const { samples } = recordVolDeclineSample(s.volSamples, vol, now);
      s.volSamples = samples;
      const trusted = getKnifeTrustedPrice(s.mint, now);
      if (trusted && tryVolDecayExit(cfg, s, trusted.priceUsd, now)) {
        log.info(
          {
            mint: s.mint,
            metric: cfg.volDecay.metric,
            consecutiveMin: cfg.volDecay.consecutiveMin,
            latestVolUsd: vol,
          },
          'knife vol_decay exit',
        );
      }
    } catch (e) {
      log.debug({ mint: s.mint, err: (e as Error).message }, 'vol decay sample failed');
    }
  }
}

function sellFraction(
  cfg: KnifeConfig,
  s: MintState,
  price: number,
  reason: string,
  fracOfInitial: number,
  opts: { forTp?: boolean } = {},
): void {
  if (s.qty <= EPS || !(fracOfInitial > 0)) return;
  if (!isKnifeExitPriceSane(price, s.avgEntry, cfg.maxExitMovePct)) {
    log.debug(
      { mint: s.mint, price, avgEntry: s.avgEntry, reason },
      'knife sell skipped — exit price outside sane corridor',
    );
    return;
  }
  if (opts.forTp && !isKnifeTpTickSane(price, s.lastMarkPrice, cfg.maxTpTickMovePct)) {
    log.debug(
      { mint: s.mint, price, lastMark: s.lastMarkPrice, reason },
      'knife sell skipped — TP tick jump vs last Jupiter mark',
    );
    return;
  }
  const chunk = fracOfInitial * s.qtyFilled;
  const soldQty = Math.min(s.qty, chunk);
  if (soldQty <= EPS) return;
  const proceeds = soldQty * price;
  const cost = soldQty * s.avgEntry;
  s.realizedUsd += proceeds - cost;
  s.qty -= soldQty;
  s.totalSoldQty += soldQty;
  s.totalProceedsUsd += proceeds;
  s.sellSummary.push({ reason, price, qty: soldQty });
  appendJournal(cfg, {
    kind: 'knife_sell',
    mint: s.mint,
    reason,
    price,
    soldFracOfInitial: fracOfInitial,
    chunkPnlPct: Number(((price / s.avgEntry - 1) * 100).toFixed(3)),
    remainingFrac: s.qtyFilled > 0 ? Number((s.qty / s.qtyFilled).toFixed(3)) : 0,
    realizedUsd: Number(s.realizedUsd.toFixed(2)),
  });
}

function sellAll(
  cfg: KnifeConfig,
  s: MintState,
  price: number,
  reason: string,
  opts: { forTp?: boolean } = {},
): void {
  if (s.qty <= EPS) return;
  sellFraction(cfg, s, price, reason, s.qty / s.qtyFilled, opts);
  while (s.qty > EPS) {
    sellFraction(cfg, s, price, reason, s.qty / s.qtyFilled, opts);
  }
}

/**
 * Detect whale dump from a large sell swap that prints a fast drop from a recent local high.
 */
export function detectWhaleDump(
  buf: PricePoint[],
  price: number,
  tsMs: number,
  meta: ShyftObservationMeta,
  cfg: Pick<
    KnifeConfig,
    'minSellUsd' | 'minDumpPct' | 'preDumpHighMs' | 'maxDrawdownPct'
  >,
): PendingWhaleDump | null {
  if (meta.side !== 'sell') return null;
  if (!(meta.amountUsd >= cfg.minSellUsd)) return null;

  const preHigh = recentHigh(buf, tsMs, cfg.preDumpHighMs);
  if (!(preHigh > 0)) return null;

  const dumpPct = ((preHigh - price) / preHigh) * 100;
  if (dumpPct < cfg.minDumpPct) return null;
  if (dumpPct > cfg.maxDrawdownPct) return null;

  return {
    detectedAtMs: tsMs,
    preDumpHigh: preHigh,
    dumpLow: price,
    dumpPct: Number(dumpPct.toFixed(2)),
    sellUsd: meta.amountUsd,
    signature: meta.signature,
    source: meta.source,
  };
}

function tryWhaleDumpEntry(
  cfg: KnifeConfig,
  s: MintState,
  price: number,
  tsMs: number,
): void {
  if (!s.pendingDump) return;

  if (!isKnifeEntryAllowed(s.mint, knifeAnalyticsCfg)) {
    const cached = getCachedKnifeAnalyticsVerdict(s.mint);
    appendJournal(cfg, {
      kind: 'knife_entry_blocked',
      mint: s.mint,
      reason: 'analytics_gate',
      analyticsReasons: cached?.reasons ?? ['no_cached_verdict'],
    });
    s.pendingDump = null;
    log.info(
      { mint: s.mint, reasons: cached?.reasons ?? [] },
      'knife entry blocked — analytics gate',
    );
    return;
  }

  const elapsed = tsMs - s.pendingDump.detectedAtMs;
  if (elapsed > cfg.maxEntryAfterDumpMs) {
    s.pendingDump = null;
    return;
  }

  if (price < s.pendingDump.dumpLow) s.pendingDump.dumpLow = price;

  const bouncePct = ((price - s.pendingDump.dumpLow) / s.pendingDump.dumpLow) * 100;
  if (bouncePct > cfg.maxBounceFromDumpPct) {
    s.pendingDump = null;
    return;
  }

  if (tsMs - globalLastEntryAtMs < cfg.globalEntryGapMs) return;

  fillLeg(s, cfg.legUsd, price);
  s.phase = 'in_pos';
  s.leg1Price = price;
  s.entryTs = tsMs;
  s.peak = price;
  s.lastMarkPrice = price;
  s.volSamples = [];
  globalLastEntryAtMs = tsMs;

  const dump = s.pendingDump;
  s.pendingDump = null;

  appendJournal(cfg, {
    kind: 'knife_entry',
    mint: s.mint,
    trigger: 'whale_dump',
    leg: 1,
    price,
    preDumpHigh: dump.preDumpHigh,
    dumpPct: dump.dumpPct,
    sellUsd: dump.sellUsd,
    signature: dump.signature,
    source: dump.source,
    legUsd: cfg.legUsd,
    bouncePct: Number(bouncePct.toFixed(2)),
    entryDelayMs: elapsed,
  });
  notifyHtml(
    cfg,
    buildKnifeEntryTelegram({
      mode: cfg.mode,
      mint: s.mint,
      legUsd: cfg.legUsd,
      priceUsd: price,
      dump,
      bouncePct: Number(bouncePct.toFixed(2)),
      entryDelayMs: elapsed,
    }),
  );
  log.info(
    { mint: s.mint, price, dumpPct: dump.dumpPct, sellUsd: dump.sellUsd },
    'knife whale-dump entry leg1',
  );
}

function tryFlushLeg2(
  cfg: KnifeConfig,
  s: MintState,
  price: number,
  tsMs: number,
): void {
  const result = evaluateKnifeFlushLeg2(cfg, s, price, tsMs, globalLastEntryAtMs);
  if (!result.fired) return;

  globalLastEntryAtMs = tsMs;
  appendJournal(cfg, {
    kind: 'knife_flush_leg2',
    mint: s.mint,
    leg: 2,
    price,
    dumpPct: result.dumpPct,
    bouncePct: result.bouncePct,
    legUsd: cfg.legUsd,
    avgEntry: s.avgEntry,
    investedUsd: s.investedUsd,
  });
  notifyHtml(
    cfg,
    buildKnifeAvgTelegram({
      mode: cfg.mode,
      mint: s.mint,
      legUsd: cfg.legUsd,
      priceUsd: price,
      dropFromLeg1Pct: Number((((s.leg1Price - price) / s.leg1Price) * 100).toFixed(1)),
      avgEntry: s.avgEntry,
    }),
  );
  log.info(
    { mint: s.mint, price, dumpPct: result.dumpPct, avgEntry: s.avgEntry },
    'knife flush floor leg2',
  );
}

function onPriceInPosition(
  cfg: KnifeConfig,
  s: MintState,
  price: number,
  tsMs: number,
  source: KnifePriceSource,
): void {
  if (source !== 'jupiter') return;

  s.lastMarkPrice = price;
  if (price > s.peak) s.peak = price;

  const ladder = cfg.exitLadder;
  const pnlPct = knifePnlPct(price, s.avgEntry);

  tryFlushLeg2(cfg, s, price, tsMs);

  if (
    cfg.avgLegEnabled &&
    s.legs < 2 &&
    price <= s.leg1Price * (1 - cfg.avgDropPct / 100)
  ) {
    fillLeg(s, cfg.legUsd, price);
    appendJournal(cfg, {
      kind: 'knife_avg_leg',
      mint: s.mint,
      leg: 2,
      price,
      dropFromLeg1Pct: Number(((s.leg1Price - price) / s.leg1Price) * 100),
      avgEntry: s.avgEntry,
      investedUsd: s.investedUsd,
    });
    notifyHtml(
      cfg,
      buildKnifeAvgTelegram({
        mode: cfg.mode,
        mint: s.mint,
        legUsd: cfg.legUsd,
        priceUsd: price,
        dropFromLeg1Pct: Number((((s.leg1Price - price) / s.leg1Price) * 100).toFixed(1)),
        avgEntry: s.avgEntry,
      }),
    );
    log.info({ mint: s.mint, price, avgEntry: s.avgEntry }, 'knife avg leg2');
  }

  if (tryVolDecayExit(cfg, s, price, tsMs)) return;

  if (pnlPct <= -ladder.killPct) {
    sellAll(cfg, s, price, 'kill');
    closePosition(cfg, s, tsMs, 'kill');
    return;
  }

  const holdMs = tsMs - s.entryTs;
  const tpAllowed = holdMs >= cfg.minHoldBeforeTpMs;

  if (tpAllowed) {
    const snap = updatePeakTrailArm(ladder, {
      firedRungPnls: s.ladderFiredPnls,
      peakPnlPct: s.peakPnlPct,
      trailArmed: s.trailArmed,
    }, pnlPct);
    s.peakPnlPct = snap.peakPnlPct;
    s.trailArmed = snap.trailArmed;

    for (const rungIdx of newlyReachableRungs(ladder, s.ladderFiredPnls, pnlPct)) {
      const thr = nextGridRungPnl(ladder, rungIdx);
      const frac = sellFracForRungIndex(ladder, rungIdx);
      const qtyBefore = s.qty;
      sellFraction(cfg, s, price, `tp_grid_${thr.toFixed(1)}pct`, frac, { forTp: true });
      if (s.qty < qtyBefore - EPS) {
        s.ladderFiredPnls = markRungFired(s.ladderFiredPnls, thr);
      }
    }

    if (ladderRetraceTriggered(ladder, s.ladderFiredPnls, pnlPct) && s.qty > EPS) {
      sellAll(cfg, s, price, 'ladder_retrace', { forTp: true });
      closePosition(cfg, s, tsMs, 'ladder_retrace');
      return;
    }

    if (
      peakTrailTriggered(
        ladder,
        { firedRungPnls: s.ladderFiredPnls, peakPnlPct: s.peakPnlPct, trailArmed: s.trailArmed },
        pnlPct,
      ) &&
      s.qty > EPS
    ) {
      sellAll(cfg, s, price, 'peak_trail', { forTp: true });
      closePosition(cfg, s, tsMs, 'peak_trail');
      return;
    }
  }

  if (cfg.maxHoldMs > 0 && tsMs - s.entryTs >= cfg.maxHoldMs && s.qty > EPS) {
    sellAll(cfg, s, price, 'timeout');
    closePosition(cfg, s, tsMs, 'timeout');
    return;
  }

  if (s.qty <= EPS && s.phase === 'in_pos') {
    closePosition(cfg, s, tsMs, 'ladder_complete');
  }
}

function onTrustedPriceTick(
  cfg: KnifeConfig,
  mint: string,
  price: number,
  tsMs: number,
  source: KnifePriceSource,
): void {
  lastActivityAtMs = Date.now();
  const s = getOrCreateState(mint);
  s.obsCount += 1;
  s.buf.push({ t: tsMs, p: price });
  const cutoff = tsMs - cfg.bufferMs;
  while (s.buf.length > 0 && s.buf[0]!.t < cutoff) s.buf.shift();

  if (s.phase === 'idle') {
    if (tsMs < s.cooldownUntilMs) return;
    if (tsMs - s.watchlistJoinedAtMs < cfg.watchlistWarmupMs) return;
    if (s.obsCount < cfg.minObs) return;
    if (!s.pendingDump && cfg.flushTriggerEnabled && source === 'jupiter') {
      const flush = detectRollingFlush(s.buf, price, tsMs, cfg);
      if (flush) {
        s.pendingDump = flush;
        appendJournal(cfg, {
          kind: 'knife_flush_detected',
          mint: s.mint,
          preDumpHigh: flush.preDumpHigh,
          dumpLow: flush.dumpLow,
          dumpPct: flush.dumpPct,
          windowSec: Math.round(cfg.flushWindowMs / 1000),
        });
      }
    }
    if (s.pendingDump && source !== 'jupiter') return;
    tryWhaleDumpEntry(cfg, s, price, tsMs);
    return;
  }

  onPriceInPosition(cfg, s, price, tsMs, source);
}

function onWhaleSellSwap(
  cfg: KnifeConfig,
  mint: string,
  tsMs: number,
  meta: ShyftObservationMeta,
): void {
  if (meta.side !== 'sell' || !(meta.amountUsd >= cfg.minSellUsd)) return;

  const trusted = getKnifeTrustedPrice(mint, tsMs);
  if (!trusted) {
    appendJournal(cfg, {
      kind: 'knife_price_skip',
      mint,
      reason: 'no_trusted_price_for_dump',
      sellUsd: meta.amountUsd,
    });
    return;
  }

  const s = getOrCreateState(mint);
  if (s.phase !== 'idle') return;
  if (tsMs < s.cooldownUntilMs) return;
  if (tsMs - s.watchlistJoinedAtMs < cfg.watchlistWarmupMs) return;
  if (s.obsCount < cfg.minObs) return;

  const dump = detectWhaleDump(s.buf, trusted.priceUsd, tsMs, meta, cfg);
  if (!dump) return;

  s.pendingDump = dump;
  appendJournal(cfg, {
    kind: 'knife_dump_detected',
    mint,
    preDumpHigh: dump.preDumpHigh,
    dumpLow: dump.dumpLow,
    dumpPct: dump.dumpPct,
    sellUsd: dump.sellUsd,
    signature: dump.signature,
    source: dump.source,
    priceSource: trusted.source,
  });
  notifyHtml(
    cfg,
    buildKnifeDumpTelegram({
      mode: cfg.mode,
      mint,
      dump,
      priceUsd: trusted.priceUsd,
      maxEntryAfterDumpSec: Math.round(cfg.maxEntryAfterDumpMs / 1000),
      maxBouncePct: cfg.maxBounceFromDumpPct,
    }),
  );
  log.info(
    { mint, dumpPct: dump.dumpPct, sellUsd: dump.sellUsd, priceSource: trusted.source },
    'knife whale dump detected',
  );
}

function onStreamSwap(
  cfg: KnifeConfig,
  mint: string,
  streamPrice: number,
  tsMs: number,
  meta?: ShyftObservationMeta,
): void {
  const adopted = tryAdoptKnifeSwapPrice(
    mint,
    streamPrice,
    tsMs,
    cfg.crossSourceMaxPct,
    cfg.maxTickMovePct,
  );
  if (adopted.ok) {
    onTrustedPriceTick(cfg, mint, adopted.tick.priceUsd, tsMs, adopted.tick.source);
  } else if (adopted.reason !== 'no_jupiter_anchor') {
    log.debug({ mint, reason: adopted.reason, streamPrice }, 'knife swap price rejected');
  }

  if (meta?.side === 'sell') onWhaleSellSwap(cfg, mint, tsMs, meta);
}

function onPrice(
  cfg: KnifeConfig,
  mint: string,
  price: number,
  tsMs: number,
  meta?: ShyftObservationMeta,
): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  onStreamSwap(cfg, mint, price, tsMs, meta);
}

async function refreshWatchlist(cfg: KnifeConfig): Promise<{
  mints: string[];
  rejected: Array<{ mint: string; reasons: string[] }>;
}> {
  const paperCfg = buildKnifeGuardPaperCfg(knifeAnalyticsCfg);
  const result = await filterKnifeWatchlist(
    knifeAnalyticsCfg,
    paperCfg,
    cfg.watchlistLookbackMin,
    cfg.minVol1hUsd,
    cfg.topN,
  );
  for (const p of result.passed) {
    cacheKnifeAnalyticsVerdict(p.mint, p.verdict);
  }
  for (const r of result.rejected) {
    cacheKnifeAnalyticsVerdict(r.mint, r.verdict);
  }
  return {
    mints: result.mints,
    rejected: result.rejected.map((r) => ({ mint: r.mint, reasons: r.verdict.reasons })),
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.enabled) {
    log.info('KNIFE_CATCHER_ENABLED=0 — idle (avoid PM2 restart loop on exit)');
    await new Promise<void>(() => {
      /* hang intentionally */
    });
    return;
  }
  if (!cfg.shyftToken) {
    log.warn('KNIFE_CATCHER_ENABLED=1 but SHYFT_GRPC_TOKEN missing — idle (no stream)');
    await new Promise<void>(() => {
      /* hang intentionally */
    });
    return;
  }
  if (cfg.mode === 'live') {
    log.warn('KNIFE_MODE=live requested but live execution is not wired — running SHADOW instead');
    cfg.mode = 'shadow';
  }

  log.info(
    {
      mode: cfg.mode,
      topN: cfg.topN,
      minDumpPct: cfg.minDumpPct,
      minSellUsd: cfg.minSellUsd,
      maxEntryAfterDumpSec: cfg.maxEntryAfterDumpMs / 1000,
      legUsd: cfg.legUsd,
      positionUsd: cfg.positionUsd,
      avgLegEnabled: cfg.avgLegEnabled,
      exitLadder: cfg.exitLadder,
      volDecay: cfg.volDecay,
      endpoint: cfg.shyftEndpoint,
      priceExtraction: 'swap_decode',
      analyticsEnabled: knifeAnalyticsCfg.enabled,
      minHolders: knifeAnalyticsCfg.minHolderCount,
      maxVolPerHolder1h: knifeAnalyticsCfg.maxVolPerHolder1hUsd,
      runnerGate: knifeAnalyticsCfg.runnerGateEnabled,
    },
    'knife-catcher starting',
  );

  await refreshSolPrice().catch(() => false);
  setInterval(() => {
    void refreshSolPrice().catch(() => false);
  }, 30_000).unref();

  const applyWatchlist = async (): Promise<void> => {
    try {
      knifeAnalyticsCfg = loadKnifeAnalyticsConfig();
      const { mints, rejected } = await refreshWatchlist(cfg);
      if (mints.length > 0) {
        setShyftShadowWatchedMints(mints);
        const now = Date.now();
        for (const m of mints) {
          const isNew = !states.has(m);
          const s = getOrCreateState(m);
          if (isNew) s.watchlistJoinedAtMs = now;
        }
        // Bound memory: drop states for mints no longer watched that are idle & have no open work.
        const keep = new Set(mints);
        for (const [m, s] of states) {
          if (!keep.has(m) && s.phase === 'idle' && !s.pendingDump) states.delete(m);
        }
        appendJournal(cfg, {
          kind: 'knife_watchlist',
          count: mints.length,
          mints,
          analyticsEnabled: knifeAnalyticsCfg.enabled,
          rejectedCount: rejected.length,
        });
        if (rejected.length > 0) {
          appendJournal(cfg, {
            kind: 'knife_analytics_reject',
            samples: rejected.slice(0, 12),
          });
        }
        log.info(
          {
            count: mints.length,
            rejected: rejected.length,
            analytics: knifeAnalyticsCfg.enabled,
            minHolders: knifeAnalyticsCfg.minHolderCount,
          },
          'watchlist refreshed',
        );
      } else {
        setShyftShadowWatchedMints([]);
        if (rejected.length > 0) {
          appendJournal(cfg, {
            kind: 'knife_analytics_reject',
            samples: rejected.slice(0, 12),
          });
        }
        log.warn(
          {
            rejected: rejected.length,
            analytics: knifeAnalyticsCfg.enabled,
          },
          'watchlist empty — no mints passed volume + analytics gates',
        );
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, 'watchlist refresh failed');
    }
  };

  await applyWatchlist();
  setInterval(() => {
    void applyWatchlist();
  }, cfg.watchlistRefreshMs).unref();

  const getWatchedMints = (): string[] => [...states.keys()];

  if (cfg.captureOnly) {
    log.info(
      { topN: cfg.topN, swapCapturePath: cfg.swapCapturePath },
      'KNIFE_CAPTURE_ONLY=1 — Shyft swap capture only (no Jupiter poll, no dump/entry logic)',
    );
  } else {
    startKnifeJupiterPoll(
      {
        legUsd: cfg.legUsd,
        pollIntervalMs: cfg.jupiterPollIntervalMs,
        slippageBps: cfg.jupiterSlippageBps,
        timeoutMs: cfg.jupiterTimeoutMs,
        maxMintsPerTick: cfg.jupiterMaxMintsPerTick,
      },
      getWatchedMints,
      (mint, priceUsd, streamTsMs) => {
        try {
          onTrustedPriceTick(cfg, mint, priceUsd, streamTsMs, 'jupiter');
        } catch (e) {
          log.debug({ mint, err: (e as Error).message }, 'jupiter onPrice failed');
        }
      },
    );

    if (cfg.volDecay.enabled) {
      setInterval(() => {
        void pollVolDecaySamples(cfg);
      }, cfg.volDecay.sampleMs).unref();
    }
  }

  startShyftShadowConsumer(
    {
      endpoint: cfg.shyftEndpoint,
      token: cfg.shyftToken,
      maxAccountInclude: cfg.topN,
      priceExtraction: 'swap_decode',
    },
    {
      onObservation: (mint, priceUsd, streamTsMs, meta) => {
        try {
          lastActivityAtMs = Date.now();
          if (meta) recordKnifeSwap(cfg, mint, streamTsMs, meta);
          if (!cfg.captureOnly) onStreamSwap(cfg, mint, priceUsd, streamTsMs, meta);
        } catch (e) {
          log.debug({ mint, err: (e as Error).message }, 'onStreamSwap failed');
        }
      },
      onStatus: (status, detail) =>
        appendJournal(cfg, { kind: 'knife_stream_status', status, ...(detail ? { detail } : {}) }),
      onError: (err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'stream error'),
    },
  );

  // Self-watchdog: clean exit(1) before a leak reaches the kernel OOM-killer (which threatens the
  // whole VPS). Not unref'd so it always keeps firing while the process is alive.
  setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    const lastActivityAgeMs = Date.now() - lastActivityAtMs;
    const verdict = knifeWatchdogVerdict({
      rssMb,
      lastActivityAgeMs,
      watchedCount: states.size,
      rssHardMb: cfg.watchdogRssMb,
      stallMs: cfg.watchdogStallMs,
    });
    if (verdict.exit) {
      appendJournal(cfg, {
        kind: 'knife_watchdog_exit',
        reason: verdict.reason,
        rssMb,
        lastActivityAgeSec: Math.round(lastActivityAgeMs / 1000),
        watched: states.size,
      });
      log.error(
        { reason: verdict.reason, rssMb, lastActivityAgeSec: Math.round(lastActivityAgeMs / 1000) },
        'knife-catcher watchdog tripped — exiting for clean pm2 restart',
      );
      process.exit(1);
    }
  }, cfg.watchdogCheckMs);

  setInterval(() => {
    let open = 0;
    let obs = 0;
    let realized = 0;
    let pending = 0;
    for (const s of states.values()) {
      if (s.phase === 'in_pos') open += 1;
      if (s.pendingDump) pending += 1;
      obs += s.obsCount;
      realized += s.realizedUsd;
    }
    log.info(
      {
        watched: states.size,
        open,
        pending,
        obsTotal: obs,
        swapsCaptured: swapCaptureCount,
        captureOnly: cfg.captureOnly,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        realizedUsd: Number(realized.toFixed(2)),
        solUsd: getSolUsd(),
      },
      'knife-catcher heartbeat',
    );
  }, 60_000).unref();

  let lastRealized = 0;
  setInterval(() => {
    let open = 0;
    let realized = 0;
    for (const s of states.values()) {
      if (s.phase === 'in_pos') open += 1;
      realized += s.realizedUsd;
    }
    const delta = realized - lastRealized;
    lastRealized = realized;
    let pending = 0;
    for (const s of states.values()) {
      if (s.pendingDump) pending += 1;
    }
    notifyHtml(
      cfg,
      buildKnifeSummaryTelegram({
        mode: cfg.mode,
        watched: states.size,
        open,
        pendingDumps: pending,
        realizedUsd: realized,
        periodDeltaUsd: delta,
      }),
    );
  }, cfg.summaryMs).unref();
}

const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('knife-catcher.ts') || process.argv[1].endsWith('knife-catcher.js'));

if (isMain) {
  main().catch((e) => {
    log.error({ err: (e as Error).message }, 'fatal');
    process.exit(1);
  });
}

export {
  loadConfig,
  onPrice,
  recentHigh,
  states as __knifeStatesForTests,
  globalLastEntryAtMs as __knifeGlobalLastEntryForTests,
};
