/**
 * Coordinated Rings — LIVE PAPER TRADER.
 *
 * Постоянно запущенный процесс. Каждые SCAN_INTERVAL_MS секунд:
 *   1. Находит свежие (за последние LOOKBACK_MIN минут) coordinated buy windows
 *   2. Дедуплицирует по уже открытым/закрытым позициям
 *   3. Прогоняет через фильтры:
 *        a) Independence (≥3 funders, нет фарм-меток на ≥30%)
 *        b) Dexscreener enrichment (liquidity ≥ $10k, vol survival, age)
 *        c) Jupiter pre-flight (honeypot check + slippage estimate)
 *   4. Если все фильтры прошли → виртуально покупает $10
 *
 * Параллельно каждые TRACK_INTERVAL_MS секунд:
 *   - Для всех open positions берёт current price из Dexscreener
 *   - Применяет staircase exit:
 *       +100% (2x) → sell 50%, status = partial_2x
 *       +400% (5x) → sell 30%, status = partial_5x
 *       moon bag (20%) ride с trailing -50% от пика
 *       hard stop -60% от entry → закрытие всего
 *       timeout 7 дней → закрытие moon bag по market
 *
 * NO real money. Все trade'ы пишутся в paper_trades.
 *
 * Usage:
 *   npm run paper:trader              -- старт
 *   npm run paper:trader -- --once    -- один цикл и выход (для отладки)
 *   npm run paper:stats               -- сводка
 */
import 'dotenv/config';
import { sql as dsql, eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../src/core/db/client.js';
import { child } from '../src/core/logger.js';

const log = child('rings-paper');

// ============================================================
// CONFIG
// ============================================================
const SCAN_INTERVAL_MS = 30_000;        // как часто ищем новые алерты
const TRACK_INTERVAL_MS = 30_000;       // как часто трекаем open positions
const LOOKBACK_MIN = 10;                // окно поиска свежих coordinated buys
const POSITION_SIZE_USD = 10;           // размер виртуальной позиции

// Ring detector params
const MIN_BUYERS = 5;
const WINDOW_SEC = 180;
const MIN_USD_PER_BUY = 100;            // ≈ 0.5 SOL @ $200

// Independence filter
const MIN_FUNDERS = 3;
const MAX_FARM_FRACTION = 0.3;          // ≤30% покупателей могут быть farm-tagged

// Token-quality filter
const MIN_LIQUIDITY_USD = 10_000;
const MIN_TOKEN_AGE_MIN = 30;
const MIN_VOL_SURVIVAL = 0.4;           // vol_h6 / max(vol_h1*6, 1) ≥ 0.4

// Honeypot pre-flight
const HONEYPOT_MAX_ROUND_TRIP_LOSS = 0.30;  // если roundtrip съедает >30% — honeypot

// Exit ladder
const TARGETS = [
  { mult: 2.0, sellFraction: 0.5, status: 'partial_2x' },
  { mult: 5.0, sellFraction: 0.3, status: 'partial_5x' },
];
const TRAILING_STOP_FROM_PEAK = 0.5;    // moon bag: -50% от пика
const HARD_STOP_LOSS = -0.6;            // -60% от entry → закрыть всё
const TIMEOUT_HOURS = 168;              // moon bag forced close через 7 дней

// External APIs
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================================
// HELPERS
// ============================================================
async function rows<T = any>(q: any): Promise<T[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJson<T = any>(url: string, retries = 2): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) return null;
      return await r.json() as T;
    } catch {
      await sleep(800);
    }
  }
  return null;
}

// ============================================================
// STAGE 1: find fresh coordinated-buy windows
// ============================================================
interface RingCandidate {
  mint: string;
  windowStart: string;
  uniqueBuyers: number;
  totalUsd: number;
  avgPriceUsd: number;
  buyers: string[];
}

async function findFreshRings(): Promise<RingCandidate[]> {
  const sinceIso = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
  const all = await rows<{
    base_mint: string; wallet: string; block_time: string; price_usd: number; amount_usd: number;
  }>(dsql.raw(`
    SELECT base_mint, wallet, block_time, price_usd, amount_usd
    FROM swaps
    WHERE side = 'buy' AND amount_usd >= ${MIN_USD_PER_BUY}
      AND block_time > '${sinceIso}'::timestamptz
    ORDER BY base_mint, block_time
  `));

  const byMint = new Map<string, typeof all>();
  for (const b of all) {
    if (!byMint.has(b.base_mint)) byMint.set(b.base_mint, []);
    byMint.get(b.base_mint)!.push(b);
  }

  const out: RingCandidate[] = [];
  for (const [mint, buys] of byMint) {
    if (buys.length < MIN_BUYERS) continue;
    let lastEnd = 0;
    for (let i = 0; i < buys.length; i++) {
      const startMs = new Date(buys[i].block_time).getTime();
      if (startMs < lastEnd) continue;
      const endMs = startMs + WINDOW_SEC * 1000;
      const seen = new Set<string>();
      const w: typeof all = [];
      for (let j = i; j < buys.length; j++) {
        const t = new Date(buys[j].block_time).getTime();
        if (t >= endMs) break;
        if (!seen.has(buys[j].wallet)) {
          seen.add(buys[j].wallet);
          w.push(buys[j]);
        }
      }
      if (w.length >= MIN_BUYERS) {
        out.push({
          mint,
          windowStart: buys[i].block_time,
          uniqueBuyers: w.length,
          totalUsd: w.reduce((s, x) => s + x.amount_usd, 0),
          avgPriceUsd: w.reduce((s, x) => s + x.price_usd, 0) / w.length,
          buyers: w.map(x => x.wallet),
        });
        lastEnd = endMs;
      }
    }
  }
  return out;
}

// ============================================================
// STAGE 2a: independence filter
// ============================================================
interface IndependenceResult {
  pass: boolean; funders: number; farmTagged: number; reason: string;
}

async function checkIndependence(c: RingCandidate): Promise<IndependenceResult> {
  const wallets = c.buyers.map(w => `'${w}'`).join(',');
  const fundRow = await rows<{ funders: number }>(dsql.raw(`
    SELECT COUNT(DISTINCT source_wallet)::int AS funders
    FROM money_flows
    WHERE target_wallet IN (${wallets})
      AND asset = 'SOL' AND amount > 0.05
      AND tx_time < '${c.windowStart}'
  `));
  const tagRow = await rows<{ n: number }>(dsql.raw(`
    SELECT COUNT(DISTINCT wallet)::int AS n
    FROM entity_wallets
    WHERE wallet IN (${wallets})
      AND primary_tag IN ('bot_farm_distributor','bot_farm_boss','gas_distributor',
                          'scam_operator','scam_proxy','scam_treasury','scam_payout')
  `));
  const funders = fundRow[0]?.funders ?? 0;
  const farm = tagRow[0]?.n ?? 0;
  const farmFrac = farm / c.uniqueBuyers;

  if (funders < MIN_FUNDERS) return { pass: false, funders, farmTagged: farm, reason: `funders=${funders}<${MIN_FUNDERS}` };
  if (farmFrac > MAX_FARM_FRACTION) return { pass: false, funders, farmTagged: farm, reason: `farm_frac=${farmFrac.toFixed(2)}>${MAX_FARM_FRACTION}` };
  return { pass: true, funders, farmTagged: farm, reason: 'ok' };
}

// ============================================================
// STAGE 2b: dexscreener enrichment
// ============================================================
interface DexInfo {
  poolAddress: string | null;
  priceUsd: number;
  liquidityUsd: number;
  volH1: number;
  volH6: number;
  volH24: number;
  buysH1: number;
  sellsH1: number;
  pairCreatedAt: string | null;
  ageMin: number;
}

async function fetchDexInfo(mint: string): Promise<DexInfo | null> {
  const data: any = await fetchJson(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`);
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  const top = [...data].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const created = top.pairCreatedAt ? new Date(top.pairCreatedAt) : null;
  return {
    poolAddress: top.pairAddress ?? null,
    priceUsd: Number(top.priceUsd ?? 0),
    liquidityUsd: Number(top.liquidity?.usd ?? 0),
    volH1: Number(top.volume?.h1 ?? 0),
    volH6: Number(top.volume?.h6 ?? 0),
    volH24: Number(top.volume?.h24 ?? 0),
    buysH1: Number(top.txns?.h1?.buys ?? 0),
    sellsH1: Number(top.txns?.h1?.sells ?? 0),
    pairCreatedAt: created?.toISOString() ?? null,
    ageMin: created ? (Date.now() - created.getTime()) / 60_000 : 0,
  };
}

interface QualityResult {
  pass: boolean; reason: string; details: Record<string, number | string>;
}

function checkQuality(d: DexInfo): QualityResult {
  if (d.liquidityUsd < MIN_LIQUIDITY_USD) {
    return { pass: false, reason: `liq=$${d.liquidityUsd.toFixed(0)}<$${MIN_LIQUIDITY_USD}`, details: d as any };
  }
  if (d.ageMin < MIN_TOKEN_AGE_MIN) {
    return { pass: false, reason: `age=${d.ageMin.toFixed(0)}min<${MIN_TOKEN_AGE_MIN}min`, details: d as any };
  }
  // vol survival: avg vol/h за 6ч ≥ 40% от vol/h за 1ч
  const volPerHourLast = d.volH1;
  const volPerHourSurv = d.volH6 / 6;
  const survRatio = volPerHourLast > 0 ? volPerHourSurv / volPerHourLast : 1;
  if (survRatio < MIN_VOL_SURVIVAL) {
    return { pass: false, reason: `vol_surv=${survRatio.toFixed(2)}<${MIN_VOL_SURVIVAL}`, details: d as any };
  }
  // basic sanity: buys/sells must not be in catastrophic dump
  if (d.sellsH1 > d.buysH1 * 2 && d.sellsH1 > 30) {
    return { pass: false, reason: `dumping (b/s=${d.buysH1}/${d.sellsH1})`, details: d as any };
  }
  return { pass: true, reason: 'ok', details: d as any };
}

// ============================================================
// STAGE 2c: Jupiter pre-flight (honeypot + slippage)
// ============================================================
interface PreflightResult {
  pass: boolean; reason: string;
  estimatedEntryPrice: number | null;
  roundTripLoss: number | null;
}

async function preflight(mint: string): Promise<PreflightResult> {
  // SOL→TOKEN quote on $10 (≈0.05 SOL @ 200)
  const inLamports = Math.floor(0.05 * 1e9);
  const buyQ: any = await fetchJson(
    `${JUPITER_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${inLamports}&slippageBps=300`,
  );
  if (!buyQ || !buyQ.outAmount) return { pass: false, reason: 'no_buy_quote', estimatedEntryPrice: null, roundTripLoss: null };
  const tokensOut = BigInt(buyQ.outAmount);
  if (tokensOut === 0n) return { pass: false, reason: 'zero_out', estimatedEntryPrice: null, roundTripLoss: null };

  // TOKEN→SOL with same amount back
  const sellQ: any = await fetchJson(
    `${JUPITER_BASE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${tokensOut.toString()}&slippageBps=300`,
  );
  if (!sellQ || !sellQ.outAmount) return { pass: false, reason: 'no_sell_quote_HONEYPOT', estimatedEntryPrice: null, roundTripLoss: null };
  const solBack = Number(BigInt(sellQ.outAmount)) / 1e9;
  const roundTripLoss = 1 - solBack / 0.05;
  if (roundTripLoss > HONEYPOT_MAX_ROUND_TRIP_LOSS) {
    return { pass: false, reason: `roundtrip_loss=${(roundTripLoss * 100).toFixed(0)}%`, estimatedEntryPrice: null, roundTripLoss };
  }

  // Implied entry price USD: 0.05 SOL = $10 paid → $10 / tokens = price per token
  const decimals = Number(buyQ.outputMint?.decimals ?? buyQ.swapInfo?.outDecimals ?? 6);
  const tokensFloat = Number(tokensOut) / Math.pow(10, decimals);
  const estPrice = tokensFloat > 0 ? 10 / tokensFloat : 0;

  return { pass: true, reason: 'ok', estimatedEntryPrice: estPrice, roundTripLoss };
}

// ============================================================
// OPEN POSITION
// ============================================================
async function openPosition(c: RingCandidate, ind: IndependenceResult, d: DexInfo, pf: PreflightResult) {
  const entryPrice = pf.estimatedEntryPrice ?? d.priceUsd;
  if (!entryPrice || entryPrice <= 0) return;
  try {
    await db.insert(schema.paperTrades).values({
      mint: c.mint,
      poolAddress: d.poolAddress ?? null,
      alertTs: new Date(c.windowStart),
      entryTs: new Date(),
      entryPriceUsd: entryPrice,
      entrySizeUsd: POSITION_SIZE_USD,
      alertMeta: {
        unique_buyers: c.uniqueBuyers,
        total_usd: c.totalUsd,
        funders: ind.funders,
        farm_tagged: ind.farmTagged,
        sample_buyers: c.buyers.slice(0, 5),
      },
      filterResults: {
        liquidity_usd: d.liquidityUsd,
        age_min: d.ageMin,
        vol_h1: d.volH1, vol_h6: d.volH6, vol_h24: d.volH24,
        buys_h1: d.buysH1, sells_h1: d.sellsH1,
        roundtrip_loss: pf.roundTripLoss,
      },
      remainingFraction: 1.0,
      maxPriceSeenUsd: entryPrice,
      lastPriceUsd: entryPrice,
      status: 'open',
    }).onConflictDoNothing();
    log.info({
      mint: c.mint, entry: entryPrice.toExponential(3),
      buyers: c.uniqueBuyers, liq: d.liquidityUsd, age_min: d.ageMin.toFixed(0),
    }, 'OPENED');
  } catch (e) {
    log.warn({ mint: c.mint, err: String(e) }, 'open failed');
  }
}

// ============================================================
// STAGE 3: track open positions, apply exit ladder
// ============================================================
type PaperTradeRow = typeof schema.paperTrades.$inferSelect;

async function trackPositions() {
  const open = await db.select().from(schema.paperTrades)
    .where(dsql`${schema.paperTrades.status} NOT LIKE 'closed%'`);
  if (open.length === 0) return;

  for (const p of open) {
    try { await trackOne(p); } catch (e) {
      log.warn({ id: String(p.id), err: String(e) }, 'track failed');
    }
  }
}

async function trackOne(p: PaperTradeRow) {
  // Pull current price
  const d = await fetchDexInfo(p.mint);
  if (!d) {
    // Mint disappeared from dex → most likely rug. Mark closed_rug if we can't price.
    // BUT only after grace period of 5 minutes since entry.
    const ageMs = Date.now() - new Date(p.entryTs).getTime();
    if (ageMs > 5 * 60_000) {
      await closePosition(p, 0, 'rug_no_dex_data', 'closed_rug');
    }
    return;
  }
  const cur = d.priceUsd;
  if (!cur || cur <= 0) return;

  const peak = Math.max(p.maxPriceSeenUsd, cur);
  const ret = cur / p.entryPriceUsd - 1;
  const trailingDrop = peak > 0 ? 1 - cur / peak : 0;
  const ageHours = (Date.now() - new Date(p.entryTs).getTime()) / 3_600_000;

  // 1. Hard stop loss
  if (ret <= HARD_STOP_LOSS) {
    await sellAll(p, cur, 'hard_stop_loss', 'closed_loss');
    return;
  }

  // 2. Timeout for moon bag
  if (ageHours >= TIMEOUT_HOURS && p.remainingFraction > 0) {
    await sellAll(p, cur, 'timeout_7d', p.realizedPnlUsd > 0 ? 'closed_timeout' : 'closed_timeout');
    return;
  }

  // 3. Staircase targets
  const events = (p.exitEvents as any[]) ?? [];
  const reachedStatuses = new Set(events.map(e => e.target_status));

  for (const t of TARGETS) {
    if (reachedStatuses.has(t.status)) continue;
    if (cur / p.entryPriceUsd >= t.mult) {
      await sellFraction(p, cur, t.sellFraction, `target_${t.mult}x`, t.status);
      // refresh p object
      const fresh = await db.select().from(schema.paperTrades)
        .where(eq(schema.paperTrades.id, p.id)).limit(1);
      if (fresh[0]) Object.assign(p, fresh[0]);
    }
  }

  // 4. Moon bag trailing stop (only if past 5x target)
  if (reachedStatuses.has('partial_5x') && p.remainingFraction > 0 && trailingDrop >= TRAILING_STOP_FROM_PEAK) {
    await sellAll(p, cur, `trailing_stop_-${(trailingDrop*100).toFixed(0)}%`, 'closed_win');
    return;
  }

  // Update peak/last price
  await db.update(schema.paperTrades).set({
    maxPriceSeenUsd: peak,
    lastPriceUsd: cur,
    lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
}

async function sellFraction(p: PaperTradeRow, price: number, fraction: number, reason: string, newStatus: string) {
  const sellSizeUsd = p.entrySizeUsd * fraction * (price / p.entryPriceUsd);
  // Realized PnL on this slice = sellValue - costOfSlice
  const costOfSlice = p.entrySizeUsd * fraction;
  const pnlUsd = sellSizeUsd - costOfSlice;
  const newRem = Math.max(0, p.remainingFraction - fraction);
  const events = [...((p.exitEvents as any[]) ?? []), {
    ts: new Date().toISOString(), fraction, price, reason, target_status: newStatus,
    pnl_usd: pnlUsd, value_usd: sellSizeUsd,
  }];
  await db.update(schema.paperTrades).set({
    remainingFraction: newRem,
    realizedPnlUsd: p.realizedPnlUsd + pnlUsd,
    status: newRem > 0 ? newStatus : 'closed_win',
    exitEvents: events,
    closedAt: newRem > 0 ? null : new Date(),
    lastPriceUsd: price,
    lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
  log.info({ mint: p.mint, reason, price: price.toExponential(3), pnl: pnlUsd.toFixed(2), rem: newRem }, 'PARTIAL EXIT');
}

async function sellAll(p: PaperTradeRow, price: number, reason: string, finalStatus: string) {
  if (p.remainingFraction <= 0) return;
  const sellSizeUsd = p.entrySizeUsd * p.remainingFraction * (price / p.entryPriceUsd);
  const costOfSlice = p.entrySizeUsd * p.remainingFraction;
  const pnlUsd = sellSizeUsd - costOfSlice;
  const events = [...((p.exitEvents as any[]) ?? []), {
    ts: new Date().toISOString(), fraction: p.remainingFraction, price, reason,
    target_status: finalStatus, pnl_usd: pnlUsd, value_usd: sellSizeUsd,
  }];
  await db.update(schema.paperTrades).set({
    remainingFraction: 0,
    realizedPnlUsd: p.realizedPnlUsd + pnlUsd,
    status: finalStatus,
    exitEvents: events,
    closedAt: new Date(),
    lastPriceUsd: price,
    lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
  log.info({ mint: p.mint, reason, price: price.toExponential(3), pnl_total: (p.realizedPnlUsd + pnlUsd).toFixed(2), status: finalStatus }, 'CLOSED');
}

async function closePosition(p: PaperTradeRow, price: number, reason: string, status: string) {
  // For rug case (price=0): assume we lose the remaining fraction completely
  const finalPnl = p.realizedPnlUsd - p.entrySizeUsd * p.remainingFraction;
  const events = [...((p.exitEvents as any[]) ?? []), {
    ts: new Date().toISOString(), fraction: p.remainingFraction, price, reason,
    target_status: status, pnl_usd: -p.entrySizeUsd * p.remainingFraction, value_usd: 0,
  }];
  await db.update(schema.paperTrades).set({
    remainingFraction: 0,
    realizedPnlUsd: finalPnl,
    status,
    exitEvents: events,
    closedAt: new Date(),
    lastPriceUsd: price,
    lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
  log.warn({ mint: p.mint, reason, pnl_total: finalPnl.toFixed(2) }, 'RUG CLOSE');
}

// ============================================================
// SCAN CYCLE
// ============================================================
async function scanCycle() {
  const candidates = await findFreshRings();
  if (candidates.length === 0) return;

  for (const c of candidates) {
    // Already in paper_trades?
    const existing = await db.select({ id: schema.paperTrades.id })
      .from(schema.paperTrades)
      .where(dsql`${schema.paperTrades.mint} = ${c.mint} AND ${schema.paperTrades.alertTs} = ${new Date(c.windowStart)}`)
      .limit(1);
    if (existing.length > 0) continue;

    const ind = await checkIndependence(c);
    if (!ind.pass) {
      log.debug({ mint: c.mint, reason: ind.reason }, 'reject:independence');
      continue;
    }

    const dex = await fetchDexInfo(c.mint);
    if (!dex) { log.debug({ mint: c.mint }, 'reject:no_dex_data'); continue; }
    const q = checkQuality(dex);
    if (!q.pass) { log.debug({ mint: c.mint, reason: q.reason }, 'reject:quality'); continue; }

    const pf = await preflight(c.mint);
    if (!pf.pass) { log.info({ mint: c.mint, reason: pf.reason }, 'reject:preflight'); continue; }

    await openPosition(c, ind, dex, pf);
    await sleep(500);  // be nice to APIs
  }
}

// ============================================================
// MAIN LOOP
// ============================================================
async function main() {
  const once = process.argv.includes('--once');
  log.info({ once, scan_int_ms: SCAN_INTERVAL_MS, track_int_ms: TRACK_INTERVAL_MS }, 'paper-trader start');

  // Initial scan + track
  try { await scanCycle(); } catch (e) { log.error({ err: String(e) }, 'scan failed'); }
  try { await trackPositions(); } catch (e) { log.error({ err: String(e) }, 'track failed'); }

  if (once) { log.info('exit (--once)'); process.exit(0); }

  // Forever
  setInterval(() => {
    scanCycle().catch(e => log.error({ err: String(e) }, 'scan failed'));
  }, SCAN_INTERVAL_MS);

  setInterval(() => {
    trackPositions().catch(e => log.error({ err: String(e) }, 'track failed'));
  }, TRACK_INTERVAL_MS);

  // Keep alive
  await new Promise(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
