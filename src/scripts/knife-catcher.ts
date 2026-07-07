/**
 * Knife-catcher — standalone worker (isolated; NOT wired into live-oscar).
 *
 * Event-driven whale-dump entry: detect large sell swaps that print a fast dump from a recent local
 * high, enter the dip within a short window, scalp out on an escalating TP ladder + trail.
 *
 * Price path: Shyft gRPC swap_decode (per-swap balance deltas) + Jupiter buy-quote poll with
 * cross-source sanity — avoids vault-heuristic garbage prices.
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
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
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
  getKnifeCrossSourceTick,
  recordKnifePrice,
  startKnifeJupiterPoll,
} from './knife-price-feed.js';
import { sendTagged } from '../core/telegram/sender.js';

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

function parseLadder(v: unknown, def: number[]): number[] {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return def;
  const out = raw
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  return out.length > 0 ? out : def;
}

interface KnifeConfig {
  enabled: boolean;
  mode: 'shadow' | 'live';
  topN: number;
  watchlistRefreshMs: number;
  watchlistLookbackMin: number;
  minVol1hUsd: number;
  bufferMs: number;
  minDumpPct: number;
  minSellUsd: number;
  maxEntryAfterDumpMs: number;
  preDumpHighMs: number;
  maxBounceFromDumpPct: number;
  maxDrawdownPct: number;
  globalEntryGapMs: number;
  minObs: number;
  watchlistWarmupMs: number;
  crossSourceMaxPct: number;
  legUsd: number;
  positionUsd: number;
  avgDropPct: number;
  tpLadderPct: number[];
  tpSellFrac: number;
  trailPct: number;
  killPct: number;
  maxHoldMs: number;
  cooldownMs: number;
  telegramEnabled: boolean;
  summaryMs: number;
  journalPath: string;
  shyftEndpoint: string;
  shyftToken: string;
  jupiterPollIntervalMs: number;
  jupiterSlippageBps: number;
  jupiterTimeoutMs: number;
  jupiterMaxMintsPerTick: number;
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): KnifeConfig {
  const legUsd = envNum(env.KNIFE_LEG_USD, 25);
  const positionUsd = envNum(env.KNIFE_POSITION_USD, 50);
  return {
    enabled: envBool(env.KNIFE_CATCHER_ENABLED, false),
    mode: String(env.KNIFE_MODE ?? 'shadow').trim().toLowerCase() === 'live' ? 'live' : 'shadow',
    topN: Math.min(64, Math.round(envNum(env.KNIFE_TOP_N, 15))),
    watchlistRefreshMs: Math.round(envNum(env.KNIFE_WATCHLIST_REFRESH_MIN, 3) * 60_000),
    watchlistLookbackMin: envNum(env.KNIFE_WATCHLIST_LOOKBACK_MIN, 30),
    minVol1hUsd: envNum(env.KNIFE_MIN_VOL_1H_USD, 50_000),
    bufferMs: Math.round(envNum(env.KNIFE_BUFFER_SEC, 300) * 1000),
    minDumpPct: envNum(env.KNIFE_MIN_DUMP_PCT, 10),
    minSellUsd: envNum(env.KNIFE_MIN_SELL_USD, 1500),
    maxEntryAfterDumpMs: Math.round(envNum(env.KNIFE_MAX_ENTRY_AFTER_DUMP_SEC, 50) * 1000),
    preDumpHighMs: Math.round(envNum(env.KNIFE_PRE_DUMP_HIGH_SEC, 120) * 1000),
    maxBounceFromDumpPct: envNum(env.KNIFE_MAX_BOUNCE_FROM_DUMP_PCT, 5),
    maxDrawdownPct: envNum(env.KNIFE_MAX_DRAWDOWN_PCT, 40),
    globalEntryGapMs: Math.round(envNum(env.KNIFE_GLOBAL_ENTRY_GAP_SEC, 45) * 1000),
    minObs: Math.round(Number(env.KNIFE_MIN_OBS ?? 3)),
    watchlistWarmupMs: Math.round(envNum(env.KNIFE_WATCHLIST_WARMUP_SEC, 25) * 1000),
    crossSourceMaxPct: envNum(env.KNIFE_CROSS_SOURCE_MAX_PCT, 30),
    legUsd,
    positionUsd,
    avgDropPct: envNum(env.KNIFE_AVG_DROP_PCT, 8),
    tpLadderPct: parseLadder(env.KNIFE_TP_LADDER_PCT, [3.5, 12, 15]),
    tpSellFrac: Math.min(1, envNum(env.KNIFE_TP_SELL_FRAC, 0.3)),
    trailPct: envNum(env.KNIFE_TRAIL_PCT, 5),
    killPct: envNum(env.KNIFE_KILL_PCT, 50),
    maxHoldMs: Math.round(Number(env.KNIFE_MAX_HOLD_SEC ?? 0) * 1000) || 0,
    cooldownMs: Math.round(envNum(env.KNIFE_COOLDOWN_SEC, 600) * 1000),
    telegramEnabled: envBool(env.KNIFE_TELEGRAM_ENABLED, true),
    summaryMs: Math.round(envNum(env.KNIFE_SUMMARY_MIN, 30) * 60_000),
    journalPath:
      env.KNIFE_CATCHER_JOURNAL_PATH?.trim() ||
      path.join('data', 'knife-catcher', 'knife-catcher.jsonl'),
    shyftEndpoint: env.SHYFT_GRPC_ENDPOINT?.trim() || 'https://grpc.fra.shyft.to',
    shyftToken: env.SHYFT_GRPC_TOKEN?.trim() ?? '',
    jupiterPollIntervalMs: Math.round(envNum(env.KNIFE_JUPITER_POLL_SEC, 15) * 1000),
    jupiterSlippageBps: Math.round(Number(env.KNIFE_JUPITER_SLIPPAGE_BPS ?? 300)),
    jupiterTimeoutMs: Math.round(envNum(env.KNIFE_JUPITER_TIMEOUT_SEC, 8) * 1000),
    jupiterMaxMintsPerTick: Math.round(envNum(env.KNIFE_JUPITER_MAX_MINTS_PER_TICK, 5)),
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
  trailArmed: boolean;
  trailPeak: number;
  rungsFired: number;
}

const states = new Map<string, MintState>();
let journalPathResolved: string | null = null;
let globalLastEntryAtMs = 0;

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
      trailArmed: false,
      trailPeak: 0,
      rungsFired: 0,
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
  appendJournal(cfg, {
    kind: 'knife_close',
    mint: s.mint,
    reason,
    legs: s.legs,
    avgEntry: s.avgEntry,
    investedUsd: Number(s.investedUsd.toFixed(2)),
    realizedUsd: Number(s.realizedUsd.toFixed(2)),
    totalPnlPct:
      s.investedUsd > 0 ? Number(((s.realizedUsd / s.investedUsd) * 100).toFixed(3)) : 0,
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
      investedUsd: s.investedUsd,
      realizedUsd: s.realizedUsd,
      pnlPct,
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
  s.trailArmed = false;
  s.trailPeak = 0;
  s.rungsFired = 0;
}

function sellChunk(cfg: KnifeConfig, s: MintState, price: number, reason: string): void {
  if (s.qty <= EPS) return;
  const chunk = cfg.tpSellFrac * s.qtyFilled;
  const soldQty = Math.min(s.qty, chunk);
  if (soldQty <= EPS) return;
  const proceeds = soldQty * price;
  const cost = soldQty * s.avgEntry;
  s.realizedUsd += proceeds - cost;
  s.qty -= soldQty;
  appendJournal(cfg, {
    kind: 'knife_sell',
    mint: s.mint,
    reason,
    price,
    soldFracOfInitial: cfg.tpSellFrac,
    chunkPnlPct: Number(((price / s.avgEntry - 1) * 100).toFixed(3)),
    remainingFrac: s.qtyFilled > 0 ? Number((s.qty / s.qtyFilled).toFixed(3)) : 0,
    realizedUsd: Number(s.realizedUsd.toFixed(2)),
  });
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

function onPriceInPosition(cfg: KnifeConfig, s: MintState, price: number, tsMs: number): void {
  if (price > s.peak) s.peak = price;

  if (s.legs < 2 && price <= s.leg1Price * (1 - cfg.avgDropPct / 100)) {
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

  if (price <= s.avgEntry * (1 - cfg.killPct / 100)) {
    sellChunk(cfg, s, price, 'kill');
    while (s.qty > EPS) sellChunk(cfg, s, price, 'kill');
    closePosition(cfg, s, tsMs, 'kill');
    return;
  }

  while (
    s.rungsFired < cfg.tpLadderPct.length &&
    price >= s.avgEntry * (1 + cfg.tpLadderPct[s.rungsFired]! / 100)
  ) {
    sellChunk(cfg, s, price, `tp_${cfg.tpLadderPct[s.rungsFired]}pct`);
    s.rungsFired += 1;
    if (s.rungsFired >= cfg.tpLadderPct.length) {
      s.trailArmed = true;
      s.trailPeak = price;
    }
  }

  if (s.trailArmed && s.qty > EPS) {
    if (price > s.trailPeak) {
      s.trailPeak = price;
    } else if (price <= s.trailPeak * (1 - cfg.trailPct / 100)) {
      sellChunk(cfg, s, price, 'trail');
      s.trailPeak = price;
    }
  }

  if (cfg.maxHoldMs > 0 && tsMs - s.entryTs >= cfg.maxHoldMs && s.qty > EPS) {
    while (s.qty > EPS) sellChunk(cfg, s, price, 'timeout');
    closePosition(cfg, s, tsMs, 'timeout');
    return;
  }

  if (s.qty <= EPS && s.phase === 'in_pos') {
    closePosition(cfg, s, tsMs, 'ladder_complete');
  }
}

function onPrice(
  cfg: KnifeConfig,
  mint: string,
  price: number,
  tsMs: number,
  meta?: ShyftObservationMeta,
): void {
  if (!(price > 0) || !Number.isFinite(price)) return;

  if (meta) recordKnifePrice(mint, price, tsMs, meta);

  const tick = getKnifeCrossSourceTick(mint, cfg.crossSourceMaxPct, tsMs);
  const effectivePrice = tick?.priceUsd ?? price;

  const s = getOrCreateState(mint);
  s.obsCount += 1;
  s.buf.push({ t: tsMs, p: effectivePrice });
  const cutoff = tsMs - cfg.bufferMs;
  while (s.buf.length > 0 && s.buf[0]!.t < cutoff) s.buf.shift();

  if (s.phase === 'idle') {
    if (tsMs < s.cooldownUntilMs) return;
    if (tsMs - s.watchlistJoinedAtMs < cfg.watchlistWarmupMs) return;
    if (s.obsCount < cfg.minObs) return;

    if (meta?.side === 'sell') {
      const dump = detectWhaleDump(s.buf, effectivePrice, tsMs, meta, cfg);
      if (dump) {
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
        });
        notifyHtml(
          cfg,
          buildKnifeDumpTelegram({
            mode: cfg.mode,
            mint,
            dump,
            priceUsd: effectivePrice,
            maxEntryAfterDumpSec: Math.round(cfg.maxEntryAfterDumpMs / 1000),
            maxBouncePct: cfg.maxBounceFromDumpPct,
          }),
        );
        log.info(
          { mint, dumpPct: dump.dumpPct, sellUsd: dump.sellUsd },
          'knife whale dump detected',
        );
      }
    }

    tryWhaleDumpEntry(cfg, s, effectivePrice, tsMs);
    return;
  }

  onPriceInPosition(cfg, s, effectivePrice, tsMs);
}

async function refreshWatchlist(cfg: KnifeConfig): Promise<string[]> {
  const lookback = Math.max(5, Math.min(180, cfg.watchlistLookbackMin));
  const rows = (await db.execute(dsql.raw(`
    SELECT base_mint AS mint, MAX(COALESCE(volume_1h, 0)) AS vol
    FROM pumpswap_pair_snapshots
    WHERE ts >= now() - interval '${lookback} minutes'
      AND COALESCE(volume_1h, 0) >= ${cfg.minVol1hUsd}
    GROUP BY base_mint
    ORDER BY vol DESC
    LIMIT ${cfg.topN}
  `))) as unknown as Array<{ mint: string }>;
  return rows.map((r) => r.mint).filter(Boolean);
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
      tpLadderPct: cfg.tpLadderPct,
      endpoint: cfg.shyftEndpoint,
      priceExtraction: 'swap_decode',
    },
    'knife-catcher starting',
  );

  await refreshSolPrice().catch(() => false);
  setInterval(() => {
    void refreshSolPrice().catch(() => false);
  }, 30_000).unref();

  const applyWatchlist = async (): Promise<void> => {
    try {
      const mints = await refreshWatchlist(cfg);
      if (mints.length > 0) {
        setShyftShadowWatchedMints(mints);
        const now = Date.now();
        for (const m of mints) {
          const isNew = !states.has(m);
          const s = getOrCreateState(m);
          if (isNew) s.watchlistJoinedAtMs = now;
        }
        appendJournal(cfg, { kind: 'knife_watchlist', count: mints.length, mints });
        log.info({ count: mints.length }, 'watchlist refreshed');
      } else {
        log.warn('watchlist empty — no top-volume pumpswap mints in lookback window');
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

  startKnifeJupiterPoll(
    {
      legUsd: cfg.legUsd,
      pollIntervalMs: cfg.jupiterPollIntervalMs,
      slippageBps: cfg.jupiterSlippageBps,
      timeoutMs: cfg.jupiterTimeoutMs,
      crossSourceMaxPct: cfg.crossSourceMaxPct,
      maxMintsPerTick: cfg.jupiterMaxMintsPerTick,
    },
    getWatchedMints,
    (mint, priceUsd, streamTsMs) => {
      try {
        onPrice(cfg, mint, priceUsd, streamTsMs);
      } catch (e) {
        log.debug({ mint, err: (e as Error).message }, 'jupiter onPrice failed');
      }
    },
  );

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
          onPrice(cfg, mint, priceUsd, streamTsMs, meta);
        } catch (e) {
          log.debug({ mint, err: (e as Error).message }, 'onPrice failed');
        }
      },
      onStatus: (status, detail) =>
        appendJournal(cfg, { kind: 'knife_stream_status', status, ...(detail ? { detail } : {}) }),
      onError: (err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'stream error'),
    },
  );

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
