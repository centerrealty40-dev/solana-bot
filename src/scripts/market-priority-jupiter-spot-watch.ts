/**
 * Jupiter Pro sub-minute spot watch: faster spike/dips Telegram + spot cache for Live Oscar.
 *
 * Poll Jupiter Price v3 every PRIORITY_JUPITER_SPOT_POLL_MS (default 10s) for priority mint universe
 * (Live Oscar heartbeat + whitelist + PG top mcap). PG minute-bar watchers skip duplicate alerts
 * via shared dedupe file when fast-path already sent.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import { buildDipsCompactAlertHtml } from './market-dips-compact-telegram-format.js';
import { fetchPrioritySpotPrices } from './priority-jupiter-spot-prices.js';
import { loadPgNearMissSpikeMints } from './priority-jupiter-spot-near-miss.js';
import {
  upsertPriorityMintSpotSnapshots,
  type PriorityMintSpotSnapshotRow,
} from './priority-mint-spot-snapshot-pg.js';
import {
  canonicalPoolRefreshIntervalMs,
  refreshCanonicalPoolsForMints,
} from './market-canonical-pool-refresh.js';
import {
  recordMarketFastAlert,
  wasMarketFastAlertRecent,
  marketFastAlertDedupeWindowMs,
} from './market-fast-alert-shared-dedupe.js';
import { isImpossibleMinuteBarSpike } from './market-retrace-sanity.js';
import {
  readPriorityJupiterSpotMintHeartbeat,
  writePriorityJupiterSpotCache,
  type PriorityJupiterSpotCache,
  type PriorityJupiterSpotEntry,
} from '../papertrader/discovery/priority-jupiter-spot-cache.js';
import {
  detectJupiterLocalHighRetrace,
  detectJupiterRiseThenRetrace,
  detectJupiterSpikeMove,
  loadJupiterSpotDetectConfigFromEnv,
  scaleMcap,
  type JupiterPriceSample,
} from './market-priority-jupiter-spot-detect.js';
import {
  retracePullbackChannelEventKey,
  reserveRetracePullbackChannelSlot,
} from './market-retrace-pullback-channel-dedupe.js';

type MintMeta = {
  mint: string;
  symbol: string | null;
  token_name: string | null;
  refMcapUsd: number;
  refPx: number;
  liqUsd: number | null;
  holderCount: number | null;
};

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

const POLL_MS = Math.max(5000, Math.min(60_000, Math.floor(envNum('PRIORITY_JUPITER_SPOT_POLL_MS', 10_000))));
const MAX_MINTS = Math.max(10, Math.min(300, Math.floor(envNum('PRIORITY_JUPITER_SPOT_MAX_MINTS', 120))));
const MIN_MCAP = Math.max(0, envNum('PRIORITY_JUPITER_SPOT_MIN_MCAP_USD', envNum('SPIKE_ALERT_MIN_MARKET_CAP_USD', 2_000_000)));
const DRY_RUN = envBool('PRIORITY_JUPITER_SPOT_DRY_RUN', false);
const SPIKE_ENABLED = envBool('PRIORITY_JUPITER_SPOT_SPIKE_TELEGRAM', true);
const DIPS_ENABLED = envBool('PRIORITY_JUPITER_SPOT_DIPS_TELEGRAM', true);
const DISPLAY_TZ = process.env.SPIKE_ALERT_DISPLAY_TZ?.trim() || 'Europe/Moscow';

const SPIKE_TG_TOKEN = process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN?.trim() || '';
const SPIKE_TG_CHAT = process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID?.trim() || '';
const DIPS_TG_TOKEN =
  process.env.PULLBACK_ALERT_TELEGRAM_BOT_TOKEN?.trim() ||
  process.env.RETRACE_ALERT_TELEGRAM_BOT_TOKEN?.trim() ||
  '';
const DIPS_TG_CHAT =
  process.env.PULLBACK_ALERT_TELEGRAM_CHAT_ID?.trim() ||
  process.env.RETRACE_ALERT_TELEGRAM_CHAT_ID?.trim() ||
  '';

const SAMPLE_TTL_MS = Math.max(POLL_MS * 6, 20 * 60_000);
const detectCfg = loadJupiterSpotDetectConfigFromEnv();

const priceHistory = new Map<string, JupiterPriceSample[]>();
const lastSpikeSentMs = new Map<string, number>();
const lastDipsPeakMs = new Map<string, number>();
let lastUniverseMints: string[] = [];

function pruneSamples(mint: string): void {
  const arr = priceHistory.get(mint);
  if (!arr) return;
  const cutoff = Date.now() - SAMPLE_TTL_MS;
  const next = arr.filter((s) => s.tsMs >= cutoff);
  if (next.length === 0) priceHistory.delete(mint);
  else priceHistory.set(mint, next);
}

function pushSample(mint: string, priceUsd: number, tsMs: number): void {
  const arr = priceHistory.get(mint) ?? [];
  arr.push({ tsMs, priceUsd });
  priceHistory.set(mint, arr);
  pruneSamples(mint);
}

async function readWhitelistMints(): Promise<string[]> {
  const p =
    process.env.LIVE_MINT_WHITELIST_PATH?.trim() ||
    process.env.PRIORITY_JUPITER_SPOT_WHITELIST_PATH?.trim() ||
    path.join('data/live/live-oscar-mint-whitelist.txt');
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  try {
    const raw = await fs.readFile(abs, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 32 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

async function loadPgTopMints(limit: number): Promise<string[]> {
  const q = `
    WITH latest AS (
      SELECT base_mint AS mint, MAX(ts) AS ts_max
      FROM (
        SELECT base_mint, ts FROM meteora_pair_snapshots WHERE ts > NOW() - INTERVAL '2 hours'
        UNION ALL SELECT base_mint, ts FROM raydium_pair_snapshots WHERE ts > NOW() - INTERVAL '2 hours'
        UNION ALL SELECT base_mint, ts FROM orca_pair_snapshots WHERE ts > NOW() - INTERVAL '2 hours'
        UNION ALL SELECT base_mint, ts FROM pumpswap_pair_snapshots WHERE ts > NOW() - INTERVAL '2 hours'
      ) u
      GROUP BY base_mint
      ORDER BY ts_max DESC
      LIMIT ${Math.max(limit * 3, 200)}
    )
    SELECT DISTINCT ON (l.mint)
      l.mint,
      t.symbol,
      t.name AS token_name,
      COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) AS ref_mcap,
      s.price_usd AS ref_px,
      s.liquidity_usd AS liq_usd,
      t.holder_count
    FROM latest l
    JOIN meteora_pair_snapshots s ON s.base_mint = l.mint
    LEFT JOIN tokens t ON t.mint = l.mint
    WHERE COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) >= ${MIN_MCAP}
    ORDER BY l.mint, s.liquidity_usd DESC NULLS LAST, s.ts DESC
    LIMIT ${limit}
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  return rows.map((row) => String(row.mint ?? '')).filter((m) => m.length >= 32);
}

async function loadMintMetaMap(mints: string[]): Promise<Map<string, MintMeta>> {
  const out = new Map<string, MintMeta>();
  if (mints.length === 0) return out;
  const list = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
  const q = `
    SELECT DISTINCT ON (s.base_mint)
      s.base_mint AS mint,
      t.symbol,
      t.name AS token_name,
      COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) AS ref_mcap,
      s.price_usd AS ref_px,
      s.liquidity_usd AS liq_usd,
      t.holder_count
    FROM (
      SELECT base_mint, ts, price_usd, liquidity_usd, market_cap_usd, fdv_usd FROM meteora_pair_snapshots WHERE base_mint IN (${list})
      UNION ALL SELECT base_mint, ts, price_usd, liquidity_usd, market_cap_usd, fdv_usd FROM raydium_pair_snapshots WHERE base_mint IN (${list})
      UNION ALL SELECT base_mint, ts, price_usd, liquidity_usd, market_cap_usd, fdv_usd FROM orca_pair_snapshots WHERE base_mint IN (${list})
      UNION ALL SELECT base_mint, ts, price_usd, liquidity_usd, market_cap_usd, fdv_usd FROM pumpswap_pair_snapshots WHERE base_mint IN (${list})
    ) s
    LEFT JOIN tokens t ON t.mint = s.base_mint
    ORDER BY s.base_mint, s.liquidity_usd DESC NULLS LAST, s.ts DESC
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const mint = String(row.mint ?? '').trim();
    if (mint.length < 32) continue;
    const refMcap = Number(row.ref_mcap ?? 0);
    const refPx = Number(row.ref_px ?? 0);
    out.set(mint, {
      mint,
      symbol: row.symbol != null ? String(row.symbol) : null,
      token_name: row.token_name != null ? String(row.token_name) : null,
      refMcapUsd: refMcap > 0 ? refMcap : 0,
      refPx: refPx > 0 ? refPx : 0,
      liqUsd: row.liq_usd != null ? Number(row.liq_usd) : null,
      holderCount: row.holder_count != null ? Number(row.holder_count) : null,
    });
  }
  return out;
}

async function buildMintUniverse(): Promise<{ mints: string[]; hotMintSet: Set<string> }> {
  const nearMissLimit = Math.max(0, Math.min(40, Math.floor(envNum('PRIORITY_JUPITER_SPOT_NEAR_MISS_MAX', 25))));
  const [heartbeat, whitelist, pgTop, nearMiss] = await Promise.all([
    readPriorityJupiterSpotMintHeartbeat(),
    readWhitelistMints(),
    loadPgTopMints(MAX_MINTS).catch((err) => {
      console.warn('[priority-jupiter-spot-watch] pg top mints failed', err);
      return [] as string[];
    }),
    nearMissLimit > 0 ? loadPgNearMissSpikeMints(nearMissLimit) : Promise.resolve([]),
  ]);
  const hotMintSet = new Set<string>([...heartbeat, ...whitelist]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of [heartbeat, whitelist, nearMiss, pgTop]) {
    for (const m of src) {
      const k = m.trim();
      if (k.length < 32 || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      if (out.length >= MAX_MINTS) return { mints: out, hotMintSet };
    }
  }
  return { mints: out, hotMintSet };
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  if (!token || !chatId) return false;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.warn('[priority-jupiter-spot-watch] sendMessage failed', res.status, errBody.slice(0, 300));
    return false;
  }
  return true;
}

async function runTick(): Promise<void> {
  const { mints, hotMintSet } = await buildMintUniverse();
  if (mints.length === 0) return;

  const metaMap = await loadMintMetaMap(mints).catch((err) => {
    console.warn('[priority-jupiter-spot-watch] mint meta load failed', err);
    return new Map<string, MintMeta>();
  });
  const snapshotPxByMint = new Map<string, number>();
  for (const mint of mints) {
    const refPx = metaMap.get(mint)?.refPx;
    if (refPx != null && refPx > 0) snapshotPxByMint.set(mint, refPx);
  }

  const prices = await fetchPrioritySpotPrices({
    mints,
    hotMintSet,
    snapshotPxByMint,
    timeoutMs: envNum('PRIORITY_JUPITER_SPOT_TIMEOUT_MS', 8000),
  });

  const nowMs = Date.now();
  const cache: PriorityJupiterSpotCache = { updatedAt: new Date(nowMs).toISOString(), entries: {} };
  let quoteCount = 0;
  let v3Count = 0;
  let dexCount = 0;
  const pgRows: PriorityMintSpotSnapshotRow[] = [];

  for (const mint of mints) {
    const spot = prices.get(mint);
    if (!spot || !(spot.priceUsd > 0)) continue;
    const px = spot.priceUsd;
    if (spot.source === 'jupiter_quote') quoteCount += 1;
    else if (spot.source === 'dexscreener') dexCount += 1;
    else v3Count += 1;
    pushSample(mint, px, nowMs);

    const meta = metaMap.get(mint);
    let refMcap = meta?.refMcapUsd && meta.refMcapUsd > 0 ? meta.refMcapUsd : 0;
    let refPx = meta?.refPx && meta.refPx > 0 ? meta.refPx : 0;
    if (spot?.marketCapUsd != null && spot.marketCapUsd > 0 && refMcap <= 0) {
      refMcap = spot.marketCapUsd;
    }
    if (refPx <= 0 && px > 0) refPx = px;
    const mcapNow = scaleMcap(refMcap, refPx, px);

    const entry: PriorityJupiterSpotEntry = {
      mint,
      priceUsd: px,
      mcapUsd: mcapNow,
      tsMs: nowMs,
      source: spot.source,
    };
    cache.entries[mint] = entry;

    pgRows.push({
      mint,
      pairAddress: spot.pairAddress ?? null,
      priceUsd: px,
      marketCapUsd: (mcapNow ?? 0) > 0 ? mcapNow : null,
      liquidityUsd: spot.liquidityUsd ?? meta?.liqUsd ?? null,
      source: spot.source,
      tsMs: nowMs,
    });

    const samples = priceHistory.get(mint) ?? [];
    if (samples.length < 2) continue;

    const spike = detectJupiterSpikeMove(samples, refMcap || mcapNow || 0, detectCfg);
    if (spike && SPIKE_ENABLED && SPIKE_TG_TOKEN && SPIKE_TG_CHAT) {
      const cooldownMs = Math.max(60_000, envNum('SPIKE_ALERT_MINT_COOLDOWN_MINUTES', 5) * 60_000);
      const last = lastSpikeSentMs.get(mint) ?? 0;
      if (nowMs - last >= cooldownMs && !(await wasMarketFastAlertRecent(mint, 'spike'))) {
        const anchorMcap = scaleMcap(refMcap, refPx, spike.anchorPx);
        const nowMcap = scaleMcap(refMcap, refPx, spike.nowPx);
        process.env.SPIKE_ALERT_SKIP_MAIN = '1';
        const { buildAlertHtml } = await import('./market-spike-telegram-watch.js');
        const html = buildAlertHtml({
          base_mint: mint,
          pair_address: '',
          px_now: spike.nowPx,
          ts_now: new Date(spike.nowTsMs),
          symbol: meta?.symbol ?? null,
          token_name: meta?.token_name ?? null,
          holder_count: meta?.holderCount ?? null,
          liq_usd: meta?.liqUsd ?? null,
          token_fdv_usd: refMcap > 0 ? refMcap : null,
          dex: 'jupiter-spot',
          pct: spike.pct,
          windowLabel: spike.signalKind === 'rolling' ? `rolling ${spike.rollingSpanMinutes ?? '?'}m` : 'fast ~60s',
          signalKind: spike.signalKind,
          rollingSpanMinutes: spike.rollingSpanMinutes,
          anchorPx: spike.anchorPx,
          anchorTs: new Date(spike.anchorTsMs),
          anchorMcapUsd: anchorMcap,
          nowMcapUsd: nowMcap,
        });
        if (DRY_RUN) {
          console.log('[PRIORITY_JUPITER_SPIKE_DRY]', mint.slice(0, 8), spike.pct.toFixed(2));
        } else {
          const ok = await sendTelegram(SPIKE_TG_TOKEN, SPIKE_TG_CHAT, html);
          if (ok) {
            lastSpikeSentMs.set(mint, nowMs);
            await recordMarketFastAlert(mint, 'spike', spike.pct);
          }
        }
      }
    }

    if (!DIPS_ENABLED || !DIPS_TG_TOKEN || !DIPS_TG_CHAT) continue;

    const pullback = detectJupiterLocalHighRetrace(
      samples,
      detectCfg.minPullbackRetracePct,
      Math.min(detectCfg.scanMinutesPullback, 60),
    );
    const retrace = detectJupiterRiseThenRetrace(
      samples,
      detectCfg.minRetracePumpPct,
      detectCfg.minRetraceRetracePct,
      Math.min(detectCfg.scanMinutesRetrace, 90),
    );
    const dipsPick = retrace ?? pullback;
    if (!dipsPick) continue;

    const peakMs = dipsPick.peakTsMs;
    if (lastDipsPeakMs.get(mint) === peakMs) continue;
    if (await wasMarketFastAlertRecent(mint, 'dips')) continue;

    const peakTs = new Date(dipsPick.peakTsMs);
    if (!reserveRetracePullbackChannelSlot(mint, peakTs, retrace ? 'retrace' : 'pullback')) continue;

    const refPxSanity = refPx > 0 ? refPx : dipsPick.troughPx;
    if (refMcap < MIN_MCAP || !(refPxSanity > 0)) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          component: 'priority-jupiter-spot-watch',
          msg: 'dips skip missing ref mcap/px',
          mint: mint.slice(0, 8),
          refMcap,
          refPx: refPxSanity,
        }),
      );
      continue;
    }
    if (
      isImpossibleMinuteBarSpike(
        dipsPick.peakPx,
        refPxSanity,
        refMcap,
        dipsPick.retraceFromPeakPct,
      )
    ) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          component: 'priority-jupiter-spot-watch',
          msg: 'dips skip impossible minute spike (ghost bar)',
          mint: mint.slice(0, 8),
          peakPx: dipsPick.peakPx,
          refPx: refPxSanity,
          refMcap,
          retracePct: +dipsPick.retraceFromPeakPct.toFixed(2),
        }),
      );
      continue;
    }

    const peakMcap = scaleMcap(refMcap, refPxSanity, dipsPick.peakPx);
    const troughMcap = scaleMcap(refMcap, refPxSanity, dipsPick.troughPx);
    const refForAlert = refMcap || peakMcap || troughMcap || 0;

    const html = buildDipsCompactAlertHtml({
      mint,
      symbol: meta?.symbol ?? null,
      token_name: meta?.token_name ?? null,
      retraceFromPeakPct: dipsPick.retraceFromPeakPct,
      peakTs,
      peakMcapUsd: peakMcap,
      troughTs: new Date(dipsPick.troughTsMs),
      troughMcapUsd: troughMcap,
      refMcap: refForAlert,
      displayTz: DISPLAY_TZ,
    });

    if (DRY_RUN) {
      console.log('[PRIORITY_JUPITER_DIPS_DRY]', mint.slice(0, 8), dipsPick.retraceFromPeakPct.toFixed(2));
      lastDipsPeakMs.set(mint, peakMs);
      continue;
    }

    const ok = await sendTelegram(DIPS_TG_TOKEN, DIPS_TG_CHAT, html);
    if (ok) {
      lastDipsPeakMs.set(mint, peakMs);
      await recordMarketFastAlert(mint, 'dips', -dipsPick.retraceFromPeakPct);
      console.log(
        '[priority-jupiter-spot-watch] dips sent',
        mint.slice(0, 8),
        retracePullbackChannelEventKey(mint, peakTs),
      );
    }
  }

  await writePriorityJupiterSpotCache(cache);
  lastUniverseMints = mints;
  void upsertPriorityMintSpotSnapshots(pgRows).catch((err) => {
    console.warn('[priority-jupiter-spot-watch] pg snapshot upsert error', err);
  });
  if (quoteCount + v3Count + dexCount > 0) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        component: 'priority-jupiter-spot-watch',
        msg: 'tick',
        mints: mints.length,
        hot: hotMintSet.size,
        priced: quoteCount + v3Count + dexCount,
        quote: quoteCount,
        v3: v3Count,
        dex: dexCount,
        pgRows: pgRows.length,
      }),
    );
  }
}

async function main(): Promise<void> {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      component: 'priority-jupiter-spot-watch',
      msg: 'start',
      pollMs: POLL_MS,
      maxMints: MAX_MINTS,
      minMcap: MIN_MCAP,
      dryRun: DRY_RUN,
      dedupeMs: marketFastAlertDedupeWindowMs(),
    }),
  );

  await runTick().catch((err) => {
    console.error('[priority-jupiter-spot-watch] initial tick error', err);
  });
  setInterval(() => {
    void runTick().catch((err) => {
      console.error('[priority-jupiter-spot-watch] tick error', err);
    });
  }, POLL_MS);

  if (envBool('MARKET_CANONICAL_POOL_REFRESH_ENABLED', true)) {
    const poolMs = canonicalPoolRefreshIntervalMs();
    setInterval(() => {
      if (lastUniverseMints.length === 0) return;
      void refreshCanonicalPoolsForMints(lastUniverseMints)
        .then((n) => {
          if (n > 0) {
            console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                component: 'priority-jupiter-spot-watch',
                msg: 'canonical-pool-refresh',
                updated: n,
                mints: lastUniverseMints.length,
              }),
            );
          }
        })
        .catch((err) => {
          console.warn('[priority-jupiter-spot-watch] canonical pool refresh error', err);
        });
    }, poolMs);
  }
}

if (process.env.PRIORITY_JUPITER_SPOT_SKIP_MAIN !== '1') {
  void main();
}
