/**
 * Live Runner Detector — pump.fun
 * ================================
 *
 * Идея: pump.fun = казино с тысячами solo-игроков. 99% токенов — мусор/scam.
 * Наш edge — НЕ алгоритмический (это уже автоматизировано всеми ботами),
 * а АНАЛИТИЧЕСКИЙ: используем wallet_tags + token-metadata историю чтобы
 * отсеять scam-фабрики и найти настоящего runner'а в окне 5-30 мин жизни.
 *
 * Цикл (раз в 15 сек):
 *   1. Берём из tokens все pump.fun токены с firstSeenAt в окне 5-30 мин назад
 *      и не-blacklisted, не открытые ранее.
 *   2. Для каждого считаем агрегаты по swaps:
 *        - unique_buyers, unique_sellers
 *        - sum_buy_sol, sum_sell_sol
 *        - top_wallet_buy_share
 *        - bonding curve progress (из последних свопов: solAmount накопленный)
 *   3. Применяем фильтры:
 *        a) ≥ MIN_BUYERS уникальных buyer'ов (default 20)
 *        b) buy_sol >= MIN_BUY_SOL (default 5 SOL ≈ "real attention")
 *        c) buy_sol > 1.5 × sell_sol  (не distribution-фаза)
 *        d) top-1 buyer share ≤ 30%  (нет sybil-доминирования)
 *        e) BC progress 25%..90%     (≈ vSol/85 SOL graduation target)
 *        f) anti-factory: name/symbol не повторяется среди свежих 200 mints
 *           (FARTCIN-DEV-style spammers отсекаются)
 *        g) dev wallet НЕ помечен как scam_operator/scam_proxy/scam_treasury
 *   4. Если все ОК → виртуально открываем $10 в paper_trades с
 *      filter_results = детальная разбивка фильтров для post-mortem.
 *
 * Параллельно отслеживаем все open positions каждые 30 сек (см. paper-trader).
 * Используем ту же таблицу paper_trades — runner-detector это её "feeder".
 *
 * Цена для entry/tracking:
 *   - предпочитаем последний swap.priceUsd по этому mint в нашей БД
 *     (PumpPortal даёт реал-тайм поток, что точнее dexscreener для свежих pump токенов)
 *   - fallback: dexscreener (после миграции на raydium)
 *
 * Усиление:
 *   - каждые 15 сек проверяем "near-graduation" токены (BC ≥80%) отдельно — это
 *     самый предсказуемый сигнал на pump.fun (migration spike +30..200%)
 */
import 'dotenv/config';
import { sql as dsql, eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../src/core/db/client.js';
import { child } from '../src/core/logger.js';

const log = child('runner-detector');

// =====================================================================
// CONFIG
// =====================================================================
const SCAN_INTERVAL_MS = 15_000;
const TRACK_INTERVAL_MS = 30_000;

const TOKEN_AGE_MIN_MIN = 5;
const TOKEN_AGE_MAX_MIN = 30;

// Triggers
const MIN_UNIQUE_BUYERS = 20;
const MIN_BUY_SOL = 5;
const MIN_BUY_SELL_RATIO = 1.5;
const MAX_TOP_BUYER_SHARE = 0.30;
const MIN_BC_PROGRESS = 0.25;
const MAX_BC_PROGRESS = 0.90;
const BC_GRADUATION_SOL = 85;

// Anti-factory
const ANTI_FACTORY_WINDOW = 200;       // сколько последних mints проверять на дубль имени

// Scam tags
const SCAM_DEV_TAGS = ['scam_operator', 'scam_proxy', 'scam_treasury', 'scam_payout'];

// Position
const POSITION_SIZE_USD = 10;

// Exit ladder (та же что в rings-paper-trader)
const TARGETS = [
  { mult: 2.0, sellFraction: 0.5, status: 'partial_2x' },
  { mult: 5.0, sellFraction: 0.3, status: 'partial_5x' },
];
const TRAILING_STOP_FROM_PEAK = 0.5;
const HARD_STOP_LOSS = -0.6;
const TIMEOUT_HOURS = 168;  // 7 дней moon bag

// Dexscreener fallback
const DEXSCREENER_BASE = 'https://api.dexscreener.com';

// =====================================================================
// HELPERS
// =====================================================================
async function rows<T = any>(q: any): Promise<T[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJson<T = any>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
}

// =====================================================================
// CANDIDATE DISCOVERY
// =====================================================================
interface Candidate {
  mint: string;
  symbol: string | null;
  name: string | null;
  devWallet: string | null;
  firstSeenAt: string;
  ageMin: number;
}

async function findCandidates(): Promise<Candidate[]> {
  return rows<Candidate>(dsql.raw(`
    SELECT
      t.mint, t.symbol, t.name, t.dev_wallet AS "devWallet",
      t.first_seen_at AS "firstSeenAt",
      EXTRACT(EPOCH FROM (now() - t.first_seen_at))/60 AS "ageMin"
    FROM tokens t
    WHERE t.first_seen_at BETWEEN now() - interval '${TOKEN_AGE_MAX_MIN} minutes'
                              AND now() - interval '${TOKEN_AGE_MIN_MIN} minutes'
      AND t.blacklisted = false
      AND (t.metadata->>'source') = 'pumpportal'
      AND NOT EXISTS (
        SELECT 1 FROM paper_trades p
        WHERE p.mint = t.mint AND p.alert_ts > now() - interval '1 day'
      )
  `));
}

// =====================================================================
// METRICS for one mint
// =====================================================================
interface Metrics {
  uniqueBuyers: number;
  uniqueSellers: number;
  sumBuySol: number;
  sumSellSol: number;
  topBuyerShare: number;
  bcSolAccumulated: number;     // vSolInBondingCurve - 30 (initial), or sum of net buy sol
  bcProgress: number;
  lastPriceUsd: number;
  lastBlockTime: string | null;
}

async function computeMetrics(mint: string): Promise<Metrics> {
  const r = await rows<{
    side: string; wallet: string; quote_amount_raw: string;
    amount_usd: number; price_usd: number; block_time: string;
  }>(dsql.raw(`
    SELECT side, wallet, quote_amount_raw::text AS quote_amount_raw,
           amount_usd, price_usd, block_time
    FROM swaps
    WHERE base_mint = '${mint}'
    ORDER BY block_time
  `));

  const buyers = new Map<string, number>();   // wallet -> sum quote sol
  const sellers = new Set<string>();
  let sumBuy = 0;
  let sumSell = 0;
  let lastPrice = 0;
  let lastBT: string | null = null;
  for (const s of r) {
    const sol = Number(BigInt(s.quote_amount_raw)) / 1e9;
    if (s.side === 'buy') {
      buyers.set(s.wallet, (buyers.get(s.wallet) ?? 0) + sol);
      sumBuy += sol;
    } else {
      sellers.add(s.wallet);
      sumSell += sol;
    }
    lastPrice = s.price_usd;
    lastBT = s.block_time;
  }

  let topShare = 0;
  if (sumBuy > 0) {
    let topVal = 0;
    for (const v of buyers.values()) if (v > topVal) topVal = v;
    topShare = topVal / sumBuy;
  }

  // BC progress: pump.fun стартует с 30 vSol, graduate at ~115 vSol (85 net SOL added).
  const bcAdded = sumBuy - sumSell;
  const bcProgress = Math.max(0, Math.min(1, bcAdded / BC_GRADUATION_SOL));

  return {
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    sumBuySol: sumBuy,
    sumSellSol: sumSell,
    topBuyerShare: topShare,
    bcSolAccumulated: bcAdded,
    bcProgress,
    lastPriceUsd: lastPrice,
    lastBlockTime: lastBT,
  };
}

// =====================================================================
// FILTERS
// =====================================================================
interface FilterResult { pass: boolean; reason: string; details: Record<string, any>; }

function checkActivity(m: Metrics): FilterResult {
  if (m.uniqueBuyers < MIN_UNIQUE_BUYERS)
    return { pass: false, reason: `buyers=${m.uniqueBuyers}<${MIN_UNIQUE_BUYERS}`, details: {} };
  if (m.sumBuySol < MIN_BUY_SOL)
    return { pass: false, reason: `buy_sol=${m.sumBuySol.toFixed(2)}<${MIN_BUY_SOL}`, details: {} };
  if (m.sumSellSol > 0 && m.sumBuySol / m.sumSellSol < MIN_BUY_SELL_RATIO)
    return { pass: false, reason: `b/s_ratio=${(m.sumBuySol/m.sumSellSol).toFixed(2)}<${MIN_BUY_SELL_RATIO}`, details: {} };
  if (m.topBuyerShare > MAX_TOP_BUYER_SHARE)
    return { pass: false, reason: `top_share=${(m.topBuyerShare*100).toFixed(0)}%>${MAX_TOP_BUYER_SHARE*100}%`, details: {} };
  if (m.bcProgress < MIN_BC_PROGRESS)
    return { pass: false, reason: `bc=${(m.bcProgress*100).toFixed(0)}%<${MIN_BC_PROGRESS*100}%`, details: {} };
  if (m.bcProgress > MAX_BC_PROGRESS)
    return { pass: false, reason: `bc=${(m.bcProgress*100).toFixed(0)}%>${MAX_BC_PROGRESS*100}%_(graduated)`, details: {} };
  return { pass: true, reason: 'ok', details: {} };
}

async function checkAntiFactory(c: Candidate): Promise<FilterResult> {
  if (!c.symbol && !c.name) return { pass: true, reason: 'no_meta_to_check', details: {} };
  // ищем дубль имени или символа в свежих ANTI_FACTORY_WINDOW токенах
  const dupes = await rows<{ n: number }>(dsql.raw(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT mint FROM tokens
      WHERE first_seen_at > now() - interval '6 hours'
        AND mint != '${c.mint}'
        AND (
          ${c.symbol ? `symbol = '${c.symbol.replace(/'/g, "''")}'` : 'false'} OR
          ${c.name ? `name = '${c.name.replace(/'/g, "''")}'` : 'false'}
        )
      ORDER BY first_seen_at DESC LIMIT ${ANTI_FACTORY_WINDOW}
    ) x
  `));
  const n = dupes[0]?.n ?? 0;
  if (n >= 2) return { pass: false, reason: `name/symbol_duplicates=${n}`, details: { dupes: n } };
  return { pass: true, reason: 'ok', details: { dupes: n } };
}

async function checkDevReputation(c: Candidate): Promise<FilterResult> {
  if (!c.devWallet) return { pass: true, reason: 'no_dev', details: {} };
  const r = await rows<{ tag: string }>(dsql.raw(`
    SELECT primary_tag AS tag FROM entity_wallets WHERE wallet = '${c.devWallet}'
  `));
  if (r.length === 0) return { pass: true, reason: 'unknown_dev', details: { tag: null } };
  const tag = r[0].tag;
  if (SCAM_DEV_TAGS.includes(tag))
    return { pass: false, reason: `dev_is_${tag}`, details: { tag } };
  return { pass: true, reason: 'ok', details: { tag } };
}

// Бонус: smart-money среди early buyers
async function smartMoneyBonus(mint: string): Promise<{ count: number; tags: string[] }> {
  const r = await rows<{ tag: string; n: number }>(dsql.raw(`
    SELECT e.primary_tag AS tag, COUNT(*)::int AS n
    FROM swaps s
    JOIN entity_wallets e ON e.wallet = s.wallet
    WHERE s.base_mint = '${mint}' AND s.side = 'buy'
      AND e.primary_tag IN ('smart_money','rotation_node','sniper','meme_flipper')
    GROUP BY e.primary_tag
  `));
  const total = r.reduce((s, x) => s + x.n, 0);
  return { count: total, tags: r.map(x => `${x.tag}:${x.n}`) };
}

// =====================================================================
// OPEN POSITION
// =====================================================================
async function openPosition(c: Candidate, m: Metrics, bonus: { count: number; tags: string[] }, anti: FilterResult, dev: FilterResult) {
  const entryPrice = m.lastPriceUsd;
  if (!entryPrice || entryPrice <= 0) {
    log.warn({ mint: c.mint }, 'no entry price, skip');
    return;
  }
  try {
    await db.insert(schema.paperTrades).values({
      mint: c.mint,
      poolAddress: null,
      alertTs: new Date(),
      entryTs: new Date(),
      entryPriceUsd: entryPrice,
      entrySizeUsd: POSITION_SIZE_USD,
      alertMeta: {
        strategy: 'runner_detector_v1',
        symbol: c.symbol, name: c.name, dev: c.devWallet,
        age_min: c.ageMin,
        buyers: m.uniqueBuyers,
        sellers: m.uniqueSellers,
        buy_sol: m.sumBuySol,
        sell_sol: m.sumSellSol,
        top_buyer_share: m.topBuyerShare,
        bc_progress: m.bcProgress,
        smart_money_buyers: bonus.count,
        smart_money_tags: bonus.tags,
      },
      filterResults: {
        anti_factory: anti.details,
        dev_reputation: dev.details,
      },
      remainingFraction: 1.0,
      maxPriceSeenUsd: entryPrice,
      lastPriceUsd: entryPrice,
      status: 'open',
    }).onConflictDoNothing();
    log.info({
      mint: c.mint, sym: c.symbol, age_min: c.ageMin.toFixed(1),
      buyers: m.uniqueBuyers, buy_sol: m.sumBuySol.toFixed(2),
      bc: (m.bcProgress * 100).toFixed(0) + '%',
      smart: bonus.count, entry: entryPrice.toExponential(2),
    }, 'OPENED');
  } catch (e) {
    log.warn({ mint: c.mint, err: String(e) }, 'open failed');
  }
}

// =====================================================================
// SCAN CYCLE
// =====================================================================
async function scanCycle() {
  const t0 = Date.now();
  const candidates = await findCandidates();
  const stats = { found: candidates.length, rej_act: 0, rej_anti: 0, rej_dev: 0, opened: 0 };

  for (const c of candidates) {
    const m = await computeMetrics(c.mint);
    const act = checkActivity(m);
    if (!act.pass) { stats.rej_act++; continue; }

    const anti = await checkAntiFactory(c);
    if (!anti.pass) {
      stats.rej_anti++;
      log.info({ mint: c.mint, sym: c.symbol, reason: anti.reason }, 'reject:factory');
      continue;
    }

    const dev = await checkDevReputation(c);
    if (!dev.pass) {
      stats.rej_dev++;
      log.info({ mint: c.mint, sym: c.symbol, reason: dev.reason }, 'reject:dev');
      continue;
    }

    const bonus = await smartMoneyBonus(c.mint);
    stats.opened++;
    await openPosition(c, m, bonus, anti, dev);
    await sleep(200);
  }

  log.info({ ...stats, ms: Date.now() - t0 }, 'scan cycle');
}

// =====================================================================
// POSITION TRACKING (re-uses paper_trades)
// =====================================================================
type PaperTradeRow = typeof schema.paperTrades.$inferSelect;

async function getCurrentPrice(mint: string): Promise<number | null> {
  // 1. Prefer most recent pp swap (real-time)
  const r = await rows<{ price_usd: number; block_time: string }>(dsql.raw(`
    SELECT price_usd, block_time
    FROM swaps
    WHERE base_mint = '${mint}' AND price_usd > 0
    ORDER BY block_time DESC LIMIT 1
  `));
  if (r.length > 0) {
    const ageSec = (Date.now() - new Date(r[0].block_time).getTime()) / 1000;
    if (ageSec < 600) return Number(r[0].price_usd);  // less than 10 min old
  }
  // 2. fallback: dexscreener (after migration to raydium)
  const dex: any = await fetchJson(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`);
  if (Array.isArray(dex) && dex.length > 0) {
    const top = [...dex].sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const px = Number(top?.priceUsd ?? 0);
    if (px > 0) return px;
  }
  return null;
}

async function trackPositions() {
  const open = await db.select().from(schema.paperTrades)
    .where(dsql`${schema.paperTrades.status} NOT LIKE 'closed%' AND ${schema.paperTrades.alertMeta}->>'strategy' = 'runner_detector_v1'`);
  if (open.length === 0) return;

  for (const p of open) {
    try { await trackOne(p); } catch (e) {
      log.warn({ id: String(p.id), err: String(e) }, 'track failed');
    }
  }
}

async function trackOne(p: PaperTradeRow) {
  const cur = await getCurrentPrice(p.mint);
  if (cur === null || cur <= 0) {
    const ageMs = Date.now() - new Date(p.entryTs).getTime();
    if (ageMs > 5 * 60_000) await closeRug(p);
    return;
  }

  const peak = Math.max(p.maxPriceSeenUsd, cur);
  const ret = cur / p.entryPriceUsd - 1;
  const trailingDrop = peak > 0 ? 1 - cur / peak : 0;
  const ageHours = (Date.now() - new Date(p.entryTs).getTime()) / 3_600_000;

  if (ret <= HARD_STOP_LOSS) { await sellAll(p, cur, 'hard_stop_loss', 'closed_loss'); return; }
  if (ageHours >= TIMEOUT_HOURS && p.remainingFraction > 0) {
    await sellAll(p, cur, 'timeout_7d', 'closed_timeout'); return;
  }

  const events = (p.exitEvents as any[]) ?? [];
  const reachedStatuses = new Set(events.map(e => e.target_status));

  for (const t of TARGETS) {
    if (reachedStatuses.has(t.status)) continue;
    if (cur / p.entryPriceUsd >= t.mult) {
      await sellFraction(p, cur, t.sellFraction, `target_${t.mult}x`, t.status);
      const fresh = await db.select().from(schema.paperTrades).where(eq(schema.paperTrades.id, p.id)).limit(1);
      if (fresh[0]) Object.assign(p, fresh[0]);
    }
  }

  if (reachedStatuses.has('partial_5x') && p.remainingFraction > 0 && trailingDrop >= TRAILING_STOP_FROM_PEAK) {
    await sellAll(p, cur, `trailing_stop_-${(trailingDrop*100).toFixed(0)}%`, 'closed_win'); return;
  }

  await db.update(schema.paperTrades).set({
    maxPriceSeenUsd: peak, lastPriceUsd: cur, lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
}

async function sellFraction(p: PaperTradeRow, price: number, fraction: number, reason: string, newStatus: string) {
  const sellSizeUsd = p.entrySizeUsd * fraction * (price / p.entryPriceUsd);
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
    lastPriceUsd: price, lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
  log.info({ mint: p.mint, reason, pnl: pnlUsd.toFixed(2), rem: newRem }, 'PARTIAL EXIT');
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
    status: finalStatus, exitEvents: events,
    closedAt: new Date(), lastPriceUsd: price, lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
  log.info({ mint: p.mint, reason, pnl_total: (p.realizedPnlUsd + pnlUsd).toFixed(2), status: finalStatus }, 'CLOSED');
}

async function closeRug(p: PaperTradeRow) {
  const finalPnl = p.realizedPnlUsd - p.entrySizeUsd * p.remainingFraction;
  const events = [...((p.exitEvents as any[]) ?? []), {
    ts: new Date().toISOString(), fraction: p.remainingFraction, price: 0,
    reason: 'rug_no_price_data', target_status: 'closed_rug',
    pnl_usd: -p.entrySizeUsd * p.remainingFraction, value_usd: 0,
  }];
  await db.update(schema.paperTrades).set({
    remainingFraction: 0, realizedPnlUsd: finalPnl,
    status: 'closed_rug', exitEvents: events,
    closedAt: new Date(), lastCheckTs: new Date(),
  }).where(eq(schema.paperTrades.id, p.id));
  log.warn({ mint: p.mint, pnl: finalPnl.toFixed(2) }, 'RUG CLOSE');
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  const once = process.argv.includes('--once');
  log.info({ once, scan_int: SCAN_INTERVAL_MS, track_int: TRACK_INTERVAL_MS }, 'runner-detector start');

  try { await scanCycle(); } catch (e) { log.error({ err: String(e) }, 'scan failed'); }
  try { await trackPositions(); } catch (e) { log.error({ err: String(e) }, 'track failed'); }

  if (once) { log.info('exit (--once)'); process.exit(0); }

  setInterval(() => { scanCycle().catch(e => log.error({ err: String(e) }, 'scan err')); }, SCAN_INTERVAL_MS);
  setInterval(() => { trackPositions().catch(e => log.error({ err: String(e) }, 'track err')); }, TRACK_INTERVAL_MS);
  await new Promise(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
