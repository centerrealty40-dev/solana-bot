/**
 * Knife-catcher — standalone worker (isolated; NOT wired into live-oscar).
 *
 * Idea (per product owner): don't index the whole chain. Continuously track the top 10–20
 * highest-volume runners (max retail interest), and when one prints a fast "knife" (sharp
 * drawdown from a very recent local high), buy the dip a few seconds after the drop and scalp
 * out on an escalating take-profit ladder. No snapshot lag, no snipers race — seconds latency ok.
 *
 * ENTRY (2 legs, $50 total):
 *   - leg 1: enter immediately on the knife signal (no bounce wait — the first % IS the edge).
 *   - leg 2: average down $25 more only if the knife drops a further `avgDropPct` below leg 1.
 * EXIT (scalp ladder + trail): sell `tpSellFrac` (30%) of the filled size at each rung of an
 *   escalating TP ladder (3.5% / 12% / 15% / …); once the fixed rungs are done, a trailing stop
 *   keeps selling 30% chunks on each new-high → retrace (the "infinite ladder" tail). A wide
 *   `killPct` catastrophe stop closes the rest.
 *
 * ISOLATION CONTRACT:
 *  - Own PM2 process. Never imported by live-oscar / papertrader hot path.
 *  - Own Shyft Yellowstone gRPC consumer over a SMALL, slowly-changing mint set (≤ topN) — avoids
 *    the resubscribe/reconnect storm that forced Shyft OFF on live-oscar (fast mint churn there).
 *  - Uses the `shadow-state` singleton, but this is a SEPARATE process → process-local, cannot
 *    touch live-oscar.
 *  - Read-only on Postgres (watchlist ranking). Writes only its own JSONL journal.
 *  - `KNIFE_MODE=shadow` (default) journals hypothetical fills and never executes. Live execution
 *    (real swaps) is a separate wiring step (Jupiter/wallet) — intentionally not enabled here yet.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';
import { setShyftShadowWatchedMints } from '../papertrader/stream/shadow-state.js';
import { startShyftShadowConsumer } from '../papertrader/stream/shyft-shadow-consumer.js';
import { sendTagged } from '../core/telegram/sender.js';

const log = child('knife-catcher');
const EPS = 1e-12;

function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

function fmtPrice(p: number): string {
  if (!(p > 0)) return '0';
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

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
  dropWindowMs: number;
  dropPct: number;
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
    dropWindowMs: Math.round(envNum(env.KNIFE_DROP_WINDOW_SEC, 90) * 1000),
    dropPct: envNum(env.KNIFE_DROP_PCT, 15),
    legUsd,
    positionUsd,
    avgDropPct: envNum(env.KNIFE_AVG_DROP_PCT, 8),
    tpLadderPct: parseLadder(env.KNIFE_TP_LADDER_PCT, [3.5, 12, 15]),
    tpSellFrac: Math.min(1, envNum(env.KNIFE_TP_SELL_FRAC, 0.3)),
    trailPct: envNum(env.KNIFE_TRAIL_PCT, 5),
    killPct: envNum(env.KNIFE_KILL_PCT, 50),
    maxHoldMs: Math.round(Number(env.KNIFE_MAX_HOLD_SEC ?? 0) * 1000) || 0,
    cooldownMs: Math.round(envNum(env.KNIFE_COOLDOWN_SEC, 900) * 1000),
    telegramEnabled: envBool(env.KNIFE_TELEGRAM_ENABLED, true),
    summaryMs: Math.round(envNum(env.KNIFE_SUMMARY_MIN, 30) * 60_000),
    journalPath:
      env.KNIFE_CATCHER_JOURNAL_PATH?.trim() ||
      path.join('data', 'knife-catcher', 'knife-catcher.jsonl'),
    shyftEndpoint: env.SHYFT_GRPC_ENDPOINT?.trim() || 'https://grpc.fra.shyft.to',
    shyftToken: env.SHYFT_GRPC_TOKEN?.trim() ?? '',
  };
}

type Phase = 'idle' | 'in_pos';

interface PricePoint {
  t: number;
  p: number;
}

interface MintState {
  mint: string;
  buf: PricePoint[];
  phase: Phase;
  obsCount: number;
  cooldownUntilMs: number;
  // position
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

function notify(cfg: KnifeConfig, text: string): void {
  if (!cfg.telegramEnabled) return;
  const prefix = cfg.mode === 'shadow' ? '🕯 SHADOW ' : '🔪 LIVE ';
  void sendTagged('REPORT', 'knife', prefix + text, { skipQuietHours: true }).catch(() => false);
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

/** Highest price within the last `dropWindowMs`, for fast-knife drawdown reference. */
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
  notify(
    cfg,
    `✅ закрыт ${shortMint(s.mint)} (${reason}): pnl ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ` +
      `(${s.realizedUsd >= 0 ? '+' : ''}$${s.realizedUsd.toFixed(2)}), ног ${s.legs}, вложено $${s.investedUsd.toFixed(0)}`,
  );
  log.info(
    { mint: s.mint, reason, pnlUsd: Number(s.realizedUsd.toFixed(2)) },
    'knife position closed',
  );
  s.phase = 'idle';
  s.cooldownUntilMs = nowMs + cfg.cooldownMs;
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

function onPrice(cfg: KnifeConfig, mint: string, price: number, tsMs: number): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const s = getOrCreateState(mint);
  s.obsCount += 1;
  s.buf.push({ t: tsMs, p: price });
  const cutoff = tsMs - cfg.bufferMs;
  while (s.buf.length > 0 && s.buf[0]!.t < cutoff) s.buf.shift();

  if (s.phase === 'idle') {
    if (tsMs < s.cooldownUntilMs) return;
    const hi = recentHigh(s.buf, tsMs, cfg.dropWindowMs);
    if (!(hi > 0)) return;
    const drawdownPct = ((hi - price) / hi) * 100;
    if (drawdownPct >= cfg.dropPct) {
      // Immediate leg-1 entry — no bounce wait.
      fillLeg(s, cfg.legUsd, price);
      s.phase = 'in_pos';
      s.leg1Price = price;
      s.entryTs = tsMs;
      s.peak = price;
      appendJournal(cfg, {
        kind: 'knife_entry',
        mint,
        leg: 1,
        price,
        high: hi,
        drawdownPct: Number(drawdownPct.toFixed(2)),
        legUsd: cfg.legUsd,
      });
      notify(
        cfg,
        `🔪 вход ${shortMint(mint)} leg1 $${cfg.legUsd} @ ${fmtPrice(price)} ` +
          `(нож −${drawdownPct.toFixed(1)}% за ${Math.round(cfg.dropWindowMs / 1000)}с)`,
      );
      log.info({ mint, price, drawdownPct: Number(drawdownPct.toFixed(2)) }, 'knife entry leg1');
    }
    return;
  }

  // phase === 'in_pos'
  if (price > s.peak) s.peak = price;

  // Averaging leg 2 — only if the knife keeps falling below leg 1.
  if (s.legs < 2 && price <= s.leg1Price * (1 - cfg.avgDropPct / 100)) {
    fillLeg(s, cfg.legUsd, price);
    appendJournal(cfg, {
      kind: 'knife_avg_leg',
      mint,
      leg: 2,
      price,
      dropFromLeg1Pct: Number(((s.leg1Price - price) / s.leg1Price) * 100),
      avgEntry: s.avgEntry,
      investedUsd: s.investedUsd,
    });
    notify(
      cfg,
      `↓ усреднение ${shortMint(mint)} leg2 $${cfg.legUsd} @ ${fmtPrice(price)} ` +
        `(−${(((s.leg1Price - price) / s.leg1Price) * 100).toFixed(1)}% от leg1, avg ${fmtPrice(s.avgEntry)})`,
    );
    log.info({ mint, price, avgEntry: s.avgEntry }, 'knife avg leg2');
  }

  // Catastrophe kill.
  if (price <= s.avgEntry * (1 - cfg.killPct / 100)) {
    sellChunk(cfg, s, price, 'kill'); // partial safety fill on the reference chunk
    while (s.qty > EPS) sellChunk(cfg, s, price, 'kill');
    closePosition(cfg, s, tsMs, 'kill');
    return;
  }

  // Fixed escalating TP ladder — sell a chunk at each rung.
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

  // Infinite ladder tail — trailing stop sells another chunk on each new-high → retrace.
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
    // Live execution wiring (Jupiter/wallet) is intentionally not implemented in this worker yet.
    log.warn('KNIFE_MODE=live requested but live execution is not wired — running SHADOW instead');
    cfg.mode = 'shadow';
  }

  log.info(
    {
      mode: cfg.mode,
      topN: cfg.topN,
      dropPct: cfg.dropPct,
      legUsd: cfg.legUsd,
      positionUsd: cfg.positionUsd,
      avgDropPct: cfg.avgDropPct,
      tpLadderPct: cfg.tpLadderPct,
      tpSellFrac: cfg.tpSellFrac,
      trailPct: cfg.trailPct,
      endpoint: cfg.shyftEndpoint,
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
        for (const m of mints) getOrCreateState(m);
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

  startShyftShadowConsumer(
    {
      endpoint: cfg.shyftEndpoint,
      token: cfg.shyftToken,
      maxAccountInclude: cfg.topN,
    },
    {
      onObservation: (mint, priceUsd, streamTsMs) => {
        try {
          onPrice(cfg, mint, priceUsd, streamTsMs);
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
    for (const s of states.values()) {
      if (s.phase === 'in_pos') open += 1;
      obs += s.obsCount;
      realized += s.realizedUsd;
    }
    log.info(
      { watched: states.size, open, obsTotal: obs, realizedUsd: Number(realized.toFixed(2)), solUsd: getSolUsd() },
      'knife-catcher heartbeat',
    );
  }, 60_000).unref();

  // Periodic Telegram summary so the operator can follow shadow performance.
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
    notify(
      cfg,
      `📊 сводка: слежу ${states.size} монет, открыто ${open}, ` +
        `pnl (реализ.) ${realized >= 0 ? '+' : ''}$${realized.toFixed(2)} ` +
        `(за период ${delta >= 0 ? '+' : ''}$${delta.toFixed(2)})`,
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

export { loadConfig, onPrice, recentHigh, states as __knifeStatesForTests };
