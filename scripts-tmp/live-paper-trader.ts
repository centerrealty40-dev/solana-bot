/**
 * Live Paper-Trader (forward test) — DB-only edition
 * ===================================================
 *
 * Все данные для оценки берутся из локальной БД (наполняется pp:collector'ом
 * через бесплатный PumpPortal websocket). НЕ использует Helius.
 *
 * Что делает:
 *   1. Раз в 30 сек один SQL-запрос: для всех pump.fun mints возрастом
 *      7..12 мин достаём агрегаты по их swap'ам в окне [2..7 мин]:
 *        unique_buyers, unique_sellers, buy_usd, sell_usd, top_buyer_usd.
 *   2. Конвертируем USD→SOL через свежую цену Jupiter, считаем bc_progress.
 *   3. Применяем STRICT-фильтры. PASS → открываем paper-trade с текущим
 *      market_cap из pump.fun frontend-api (бесплатный).
 *   4. Раз в 60 сек обходим открытые позиции, пуллим current MC через
 *      pump.fun API, обновляем peak. Закрываем на:
 *        TP   ≥ +200%   (3x)
 *        SL   ≤ -50%
 *        TRAIL после касания 2x: -40% от пика
 *        TIMEOUT 12 ч
 *
 * Storage: append-only JSONL (env `PAPER_TRADES_PATH`, e.g. data/paper2/<strategy>.jsonl). Restart-friendly; `open`/`close` are fsynced, `open` is written before the in-memory position is registered.
 *
 * Запуск:
 *   npm run paper:live                  -- forever
 *   npm run paper:live -- --dry-run     -- только discovery, без трейдов
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

// =====================================================================
// CONFIG
// =====================================================================
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STRATEGY_ID = process.env.PAPER_STRATEGY_ID || 'paper_v1';
type Lane = 'launchpad_early' | 'migration_event' | 'post_migration';
type StrategyKind = 'fresh' | 'dip' | 'smart_lottery' | 'fresh_validated';
const STRATEGY_KIND = (process.env.PAPER_STRATEGY_KIND || 'fresh') as StrategyKind;
/** Dno / Oscar: тот же вход, что у Deep Runner (post/mig снимок + dip + whale), выходы из своего env */
const USE_DIP_ENTRY = process.env.PAPER_FV_USE_DIP_ENTRY === '1';

const POSITION_USD = Number(process.env.PAPER_POSITION_USD || 100);

// Wallet atlas signal config (used by smart_lottery + anti-scam in fresh_validated)
const ATLAS_SCAM_TAGS = (process.env.PAPER_SCAM_TAGS ||
  'scam_operator,scam_proxy,scam_treasury,scam_payout,bot_farm_distributor,bot_farm_boss,gas_distributor,terminal_distributor,insider')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ATLAS_SMART_TAGS = (process.env.PAPER_SMART_TAGS ||
  'smart_money,smart_trader,whale,sniper,meme_flipper,rotation_node')
  .split(',').map((s) => s.trim()).filter(Boolean);

const SMART_LOTTERY = {
  WINDOW_MIN: Number(process.env.PAPER_SMART_WINDOW_MIN || 5),
  MIN_AGE_MIN: Number(process.env.PAPER_SMART_MIN_AGE_MIN || 1),
  MAX_AGE_MIN: Number(process.env.PAPER_SMART_MAX_AGE_MIN || 30),
  EARLY_LIMIT: Number(process.env.PAPER_SMART_EARLY_LIMIT || 30),
  MIN_AMOUNT_USD: Number(process.env.PAPER_SMART_MIN_AMOUNT_USD || 1),
};

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
const FRESH_VALIDATED = {
  MIN_AGE_MIN: envNum('PAPER_FV_MIN_AGE_MIN', 30),
  /** 0 = без верхнего предела (берём все токены не моложе MIN_AGE) */
  MAX_AGE_MIN: envNum('PAPER_FV_MAX_AGE_MIN', 120),
  MIN_HOLDERS: Number(process.env.PAPER_FV_MIN_HOLDERS || 150),
  MIN_LIQ_USD_PROXY: Number(process.env.PAPER_FV_MIN_LIQ_USD_PROXY || 8000),
  MIN_VOL5M_USD: Number(process.env.PAPER_FV_MIN_VOL5M_USD || 1500),
  /** 0 = не проверять. Иначе buy+sell за последнюю 1 минуту (USDC) */
  MIN_VOL1M_USD: Number(process.env.PAPER_FV_MIN_VOL1M_USD || 0),
  MIN_BS_5M: Number(process.env.PAPER_FV_MIN_BS_5M || 1.3),
  MAX_TOP_SHARE: Number(process.env.PAPER_FV_MAX_TOP_SHARE || 0.25),
  MIN_GROWTH_FROM_EARLY: Number(process.env.PAPER_FV_MIN_GROWTH || 0.5),  // +50%
  EARLY_WINDOW_FROM_MIN: Number(process.env.PAPER_FV_EARLY_FROM_MIN || 10),
  EARLY_WINDOW_TO_MIN: Number(process.env.PAPER_FV_EARLY_TO_MIN || 15),
  REQUIRE_LAUNCHPAD: process.env.PAPER_FV_REQUIRE_LAUNCHPAD !== '0',
  REQUIRE_GROWTH: Number(process.env.PAPER_FV_MIN_GROWTH || 0.5) > 0,
  STRATEGY_LABEL: process.env.PAPER_FV_LABEL || 'fresh_validated',
  /** Подпись в open-трейде (pumpfun/labs и т.д.) */
  TRADE_SOURCE: (process.env.PAPER_FV_TRADE_SOURCE || 'pumpfun').replace(/[^a-z0-9_\-./]/gi, '_').slice(0, 48),
  /** 0 = выкл. Мин. USD market cap (pump frontend-api) на момент входа */
  MIN_ENTRY_MC_USD: envNum('PAPER_FV_MIN_ENTRY_MC_USD', 0),
};

/**
 * Lane 2 для FV: post-migration "validated runners" (raydium/meteora/pumpswap).
 * Использует *_pair_snapshots — НЕ жжёт QuickNode-кредиты.
 */
const FRESH_VALIDATED_POSTMIG = {
  ENABLED: process.env.PAPER_FV_POSTMIG_ENABLED === '1',
  MIN_AGE_MIN: envNum('PAPER_FV_POSTMIG_MIN_AGE_MIN', 30),
  MAX_AGE_MIN: envNum('PAPER_FV_POSTMIG_MAX_AGE_MIN', 360),
  MIN_LIQ_USD: envNum('PAPER_FV_POSTMIG_MIN_LIQ_USD', 15000),
  MIN_VOL5M_USD: envNum('PAPER_FV_POSTMIG_MIN_VOL5M_USD', 3000),
  MIN_BUYS_5M: envNum('PAPER_FV_POSTMIG_MIN_BUYS_5M', 8),
  MIN_BS: envNum('PAPER_FV_POSTMIG_MIN_BS', 1.2),
  MIN_MC_USD: envNum('PAPER_FV_POSTMIG_MIN_MC_USD', 100000),
  MAX_MC_USD: envNum('PAPER_FV_POSTMIG_MAX_MC_USD', 20000000),
};

const ENABLE_LAUNCHPAD_LANE = process.env.PAPER_ENABLE_LAUNCHPAD_LANE !== '0';
const ENABLE_MIGRATION_LANE = process.env.PAPER_ENABLE_MIGRATION_LANE !== '0';
const ENABLE_POST_LANE = process.env.PAPER_ENABLE_POST_LANE !== '0';
const GLOBAL_MIN_TOKEN_AGE_MIN = Number(process.env.PAPER_MIN_TOKEN_AGE_MIN || 0);
const GLOBAL_MIN_HOLDER_COUNT = Number(process.env.PAPER_MIN_HOLDER_COUNT || 0);

// детектор (mirror retro-validator STRICT)
const FILTERS = {
  MIN_UNIQUE_BUYERS: Number(process.env.PAPER_MIN_UNIQUE_BUYERS || 20),
  MIN_BUY_SOL: Number(process.env.PAPER_MIN_BUY_SOL || 5),
  MIN_BUY_SELL_RATIO: Number(process.env.PAPER_MIN_BUY_SELL_RATIO || 1.5),
  MAX_TOP_BUYER_SHARE: Number(process.env.PAPER_MAX_TOP_BUYER_SHARE || 0.35),
  MIN_BC_PROGRESS: Number(process.env.PAPER_MIN_BC_PROGRESS || 0.25),
  MAX_BC_PROGRESS: Number(process.env.PAPER_MAX_BC_PROGRESS || 0.95),
};
const BC_GRADUATION_SOL = Number(process.env.PAPER_BC_GRADUATION_SOL || 85);

const LANE_MIGRATION = {
  MIN_LIQ_USD: Number(process.env.PAPER_MIG_MIN_LIQ_USD || 12000),
  MIN_VOL_5M_USD: Number(process.env.PAPER_MIG_MIN_VOL_5M_USD || 1800),
  MIN_BUYS_5M: Number(process.env.PAPER_MIG_MIN_BUYS_5M || 18),
  MIN_SELLS_5M: Number(process.env.PAPER_MIG_MIN_SELLS_5M || 8),
  MIN_AGE_MIN: Number(process.env.PAPER_MIG_MIN_AGE_MIN || 2),
  MAX_AGE_MIN: Number(process.env.PAPER_MIG_MAX_AGE_MIN || 25),
};

const LANE_POST = {
  MIN_LIQ_USD: Number(process.env.PAPER_POST_MIN_LIQ_USD || 15000),
  MIN_VOL_5M_USD: Number(process.env.PAPER_POST_MIN_VOL_5M_USD || 2500),
  MIN_BUYS_5M: Number(process.env.PAPER_POST_MIN_BUYS_5M || 16),
  MIN_SELLS_5M: Number(process.env.PAPER_POST_MIN_SELLS_5M || 10),
  MIN_AGE_MIN: Number(process.env.PAPER_POST_MIN_AGE_MIN || 25),
  MAX_AGE_MIN: Number(process.env.PAPER_POST_MAX_AGE_MIN || 180),
};

/** Min buys_5m/sells_5m (count ratio) в evaluateSnapshot; было 1.1, по умолчанию 1.0 */
const SNAPSHOT_MIN_BS = envNum('PAPER_POST_MIN_BS', 1.0);

const DIP = {
  LOOKBACK_MIN: Number(process.env.PAPER_DIP_LOOKBACK_MIN || 60),
  MIN_DROP_PCT: Number(process.env.PAPER_DIP_MIN_DROP_PCT || -12),
  MAX_DROP_PCT: Number(process.env.PAPER_DIP_MAX_DROP_PCT || -45),
  MIN_IMPULSE_PCT: Number(process.env.PAPER_DIP_MIN_IMPULSE_PCT || 20),
  MIN_AGE_MIN: Number(process.env.PAPER_DIP_MIN_AGE_MIN || 25),
  // Per-mint cooldown (avoid re-buying the same coin too fast on volatile pullbacks)
  COOLDOWN_MIN_DEFAULT: Number(process.env.PAPER_DIP_COOLDOWN_MIN || 120),
  COOLDOWN_MIN_SCALP: Number(process.env.PAPER_DIP_COOLDOWN_MIN_SCALP || 20),
};

// Whale analysis (etap 5) — dip: гейт; fresh_validated: optional (PAPER_FV_WHALE_ANALYSIS_ENABLED)
const WHALE = {
  ENABLED:
    process.env.PAPER_DIP_WHALE_ANALYSIS_ENABLED === '1' || process.env.PAPER_FV_WHALE_ANALYSIS_ENABLED === '1',
  REQUIRE_TRIGGER: process.env.PAPER_DIP_REQUIRE_WHALE_TRIGGER === '1',
  LARGE_SELL_USD: Number(process.env.PAPER_DIP_LARGE_SELL_USD || 3000),
  RECENT_LOOKBACK_MIN: Number(process.env.PAPER_DIP_RECENT_LOOKBACK_MIN || 10),
  // single capitulation
  CAPITULATION_PCT: Number(process.env.PAPER_DIP_CAPITULATION_PCT || 0.7),
  // group pressure
  GROUP_SELL_USD: Number(process.env.PAPER_DIP_GROUP_SELL_USD || 5000),
  GROUP_MIN_SELLERS: Number(process.env.PAPER_DIP_GROUP_MIN_SELLERS || 2),
  GROUP_DUMP_PCT: Number(process.env.PAPER_DIP_GROUP_DUMP_PCT || 0.4),
  // creator block
  BLOCK_CREATOR_DUMP: process.env.PAPER_DIP_BLOCK_CREATOR_DUMP !== '0',
  CREATOR_DUMP_LOOKBACK_MIN: Number(process.env.PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN || 20),
  CREATOR_DUMP_MIN_PCT: Number(process.env.PAPER_DIP_CREATOR_DUMP_MIN_PCT || 0.05),
  CREATOR_DUMP_MAX_PCT: Number(process.env.PAPER_DIP_CREATOR_DUMP_MAX_PCT || 0.6),
  // dca-seller classification
  DCA_PRED_MIN_SELLS_24H: Number(process.env.PAPER_DIP_DCA_PRED_MIN_SELLS_24H || 4),
  DCA_PRED_MIN_INTERVAL_MIN: Number(process.env.PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN || 30),
  DCA_PRED_MIN_CHUNK_USD: Number(process.env.PAPER_DIP_DCA_PRED_MIN_CHUNK_USD || 3000),
  DCA_AGGR_MIN_SELLS_24H: Number(process.env.PAPER_DIP_DCA_AGGR_MIN_SELLS_24H || 6),
  DCA_AGGR_MAX_INTERVAL_MIN: Number(process.env.PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN || 15),
};

// окно
const WINDOW_START_MIN = Number(process.env.PAPER_WINDOW_START_MIN || 2);
const DECISION_AGE_MIN = Number(process.env.PAPER_DECISION_AGE_MIN || 7);
const DECISION_AGE_MAX_MIN = Number(process.env.PAPER_DECISION_AGE_MAX_MIN || 12);     // если позже — пропускаем (поздно входить)

// exit — калибровано под pump.fun волатильность (avg_peak=+61% при -50% SL = убийство upside)
const TP_X = Number(process.env.PAPER_TP_X || 5.0);                    // +400% — раньше TP только убирал апсайд
const SL_X = Number(process.env.PAPER_SL_X || 0);                      // 0 = выключен; pump.fun -50% drawdown часто предвещает +500%
const TRAIL_DROP = Number(process.env.PAPER_TRAIL_DROP || 0.5);        // -50% от пика — даём волатильности место дышать
const TRAIL_TRIGGER_X = Number(process.env.PAPER_TRAIL_TRIGGER_X || 1.3); // защищаем прибыль раньше: после +30%
const TIMEOUT_HOURS = Number(process.env.PAPER_TIMEOUT_HOURS || 12);

// ====================================================================
// Optional DCA (averaging-down) and TP-ladder (partial closes)
// PAPER_DCA_LEVELS:    "-7:0.5,-15:0.5"   -> at -7% from first entry add 50% of base, at -15% add another 50%
// PAPER_DCA_KILLSTOP:  -0.22                -> close all at -22% vs avg entry
// PAPER_DCA_REQUIRE_ALIVE: 1                -> skip DCA add if mint looks dead (no recent buys)
// PAPER_TP_LADDER:     "0.05:0.30,0.10:0.35,0.15:0.25"
//                       (sell 30% of remaining at +5%, 35% at +10%, 25% at +15%, last 10% rides trailing)
// All triggers vs avg entry price (NOT vs first entry).
// ====================================================================
function parseDcaLevels(spec: string | undefined) {
  if (!spec) return [] as Array<{ triggerPct: number; addFraction: number }>;
  return spec.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [trig, frac] = p.split(':').map((s) => Number(s));
    return { triggerPct: trig / 100, addFraction: frac };
  }).filter((l) => Number.isFinite(l.triggerPct) && Number.isFinite(l.addFraction) && l.addFraction > 0);
}
function parseLadder(spec: string | undefined) {
  if (!spec) return [] as Array<{ pnlPct: number; sellFraction: number }>;
  return spec.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [pnl, frac] = p.split(':').map((s) => Number(s));
    return { pnlPct: pnl, sellFraction: frac };
  }).filter((l) => Number.isFinite(l.pnlPct) && Number.isFinite(l.sellFraction) && l.sellFraction > 0);
}
const DCA_LEVELS = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
const DCA_KILLSTOP = Number(process.env.PAPER_DCA_KILLSTOP || 0); // e.g. -0.22 means -22%
const DCA_REQUIRE_ALIVE = process.env.PAPER_DCA_REQUIRE_ALIVE === '1';
const TP_LADDER = parseLadder(process.env.PAPER_TP_LADDER);
const HAS_DCA = DCA_LEVELS.length > 0 || DCA_KILLSTOP < 0;
const HAS_LADDER = TP_LADDER.length > 0;

// =====================================================================
// Trading costs — applied as a spread around market price.
// FEE_BPS — LP/aggregator fee (basis points: 100 = 1%)
// SLIPPAGE_BPS — expected slippage on entry/exit
// On buy: effective_entry  = market_price * (1 + (FEE+SLIP)/10000)
// On sell: effective_exit  = market_price * (1 - (FEE+SLIP)/10000)
// We log BOTH gross (no costs) and net (with costs) for every closed trade.
// =====================================================================
const FEE_BPS_PER_SIDE = Number(process.env.PAPER_FEE_BPS_PER_SIDE || 100);        // 1% default
const SLIPPAGE_BPS_PER_SIDE = Number(process.env.PAPER_SLIPPAGE_BPS_PER_SIDE || 200); // 2% default
const COST_PCT_PER_SIDE = (FEE_BPS_PER_SIDE + SLIPPAGE_BPS_PER_SIDE) / 10000;
const effBuy = (m: number) => m * (1 + COST_PCT_PER_SIDE);
const effSell = (m: number) => m * (1 - COST_PCT_PER_SIDE);

const CONTEXT_SWAPS_LIMIT = Number(process.env.PAPER_CONTEXT_SWAPS_LIMIT || 5);
const CONTEXT_SWAPS_ENABLED = process.env.PAPER_CONTEXT_SWAPS !== '0';

// Post-entry followup snapshots (e.g. "what was the price 30 / 60 minutes after we bought?")
const FOLLOWUP_OFFSETS_MIN = (process.env.PAPER_FOLLOWUP_OFFSETS_MIN || '30,60,120')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
const FOLLOWUP_ENABLED = FOLLOWUP_OFFSETS_MIN.length > 0;
const FOLLOWUP_TICK_MS = 30_000;

// частоты
const DISCOVERY_INTERVAL_MS = Number(process.env.PAPER_DISCOVERY_INTERVAL_MS || 10_000);
const TRACK_INTERVAL_MS = Number(process.env.PAPER_TRACK_INTERVAL_MS || 30_000);
const STATS_INTERVAL_MS = 5 * 60_000;
const SOL_PRICE_REFRESH_MS = 5 * 60_000;

const STORE_PATH = process.env.PAPER_TRADES_PATH || '/tmp/paper-trades.jsonl';

function ensureStoreDir(): void {
  try {
    const dir = path.dirname(STORE_PATH);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`store mkdir failed: ${err}`);
  }
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// =====================================================================
// UTILS
// =====================================================================
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJson<T = any>(url: string, retries = 2): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) return null;
      return await r.json() as T;
    } catch {
      await sleep(800);
    }
  }
  return null;
}

// =====================================================================
// SOL price (для конвертации USD→SOL)
// =====================================================================
let SOL_USD = 100;     // дефолт пока не запросили
async function refreshSolPrice(): Promise<void> {
  const j: any = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const px = Number(j?.[SOL_MINT]?.usdPrice ?? j?.data?.[SOL_MINT]?.price ?? 0);
  if (px > 20 && px < 5000) SOL_USD = px;
}

// =====================================================================
// BTC market context (ret 1h / 4h) — fed by swaps table on wrapped BTC mints
// =====================================================================
const BTC_MINTS = (process.env.PAPER_BTC_MINTS ||
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E,3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh,7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let btcRet1hPct: number | null = null;
let btcRet4hPct: number | null = null;
let btcLastUpdateTs = 0;

async function refreshBtcContext(): Promise<void> {
  try {
    if (!BTC_MINTS.length) return;
    const mintsSql = BTC_MINTS.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
    const r: any = await db.execute(dsql.raw(`
      SELECT block_time AS ts, price_usd
      FROM swaps
      WHERE base_mint IN (${mintsSql})
        AND price_usd > 0
        AND block_time >= now() - interval '6 hours'
      ORDER BY block_time ASC
    `));
    const rows: Array<{ ts: any; price_usd: number | string }> = Array.isArray(r) ? r : (r.rows ?? []);
    if (rows.length < 2) {
      btcRet1hPct = null;
      btcRet4hPct = null;
      return;
    }
    const series = rows.map((row) => ({ t: new Date(row.ts).getTime(), p: Number(row.price_usd) }));
    const latest = series[series.length - 1];
    const findClosest = (targetTs: number) => {
      let best = series[0];
      let bestDiff = Math.abs(series[0].t - targetTs);
      for (const r of series) {
        const d = Math.abs(r.t - targetTs);
        if (d < bestDiff) { best = r; bestDiff = d; }
      }
      return best;
    };
    const a1 = findClosest(latest.t - 60 * 60_000);
    const a4 = findClosest(latest.t - 4 * 60 * 60_000);
    btcRet1hPct = a1 && a1.p > 0 ? ((latest.p / a1.p) - 1) * 100 : null;
    btcRet4hPct = a4 && a4.p > 0 ? ((latest.p / a4.p) - 1) * 100 : null;
    btcLastUpdateTs = Date.now();
  } catch (err) {
    console.warn(`btc context refresh failed: ${err}`);
  }
}

function btcCtx() {
  return {
    ret1h_pct: btcRet1hPct !== null ? +btcRet1hPct.toFixed(2) : null,
    ret4h_pct: btcRet4hPct !== null ? +btcRet4hPct.toFixed(2) : null,
    updated_ts: btcLastUpdateTs || null,
  };
}

// =====================================================================
// PAPER TRADE STORE
// =====================================================================
type ExitReason = 'TP' | 'SL' | 'TRAIL' | 'TIMEOUT' | 'NO_DATA';
interface Metrics {
  uniqueBuyers: number; uniqueSellers: number;
  sumBuySol: number; sumSellSol: number;
  topBuyerShare: number; bcProgress: number;
}
interface PositionLeg {
  ts: number;
  price: number;       // EFFECTIVE entry price (with buy costs applied)
  marketPrice: number; // raw market price at entry (for gross/post-mortem)
  sizeUsd: number;     // money we paid for this leg (paper) — reduces our paper bank
  reason: 'open' | 'dca';
  triggerPct?: number; // for dca: trigger percentage that fired (-0.07, -0.15)
}
interface PartialSell {
  ts: number;
  price: number;            // EFFECTIVE sell price (with sell costs applied)
  marketPrice: number;      // raw market price at sell
  sellFraction: number;     // fraction of REMAINING position sold (0..1)
  reason: 'TP_LADDER' | 'TRAIL' | 'TIMEOUT' | 'KILLSTOP' | 'SL';
  proceedsUsd: number;      // net proceeds (with costs)
  grossProceedsUsd: number; // proceeds without costs (for gross PnL)
  pnlUsd: number;           // net pnl from this slice
  grossPnlUsd: number;      // gross pnl from this slice
}
interface OpenTrade {
  mint: string; symbol: string;
  lane: Lane;
  source?: string;
  metricType: 'mc' | 'price';
  entryTs: number;
  entryMcUsd: number;            // first leg price (kept for back-compat)
  entryMetrics: Metrics;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  // v2: DCA + ladder bookkeeping
  legs: PositionLeg[];
  partialSells: PartialSell[];
  totalInvestedUsd: number;
  avgEntry: number;              // weighted-average EFFECTIVE entry price (used for TP/SL/trail)
  avgEntryMarket: number;        // weighted-average MARKET entry price (used for gross PnL)
  remainingFraction: number;     // 1.0 - sum(sellFraction * remainingBefore)
  dcaUsedLevels: Set<number>;    // levels (in pct) already triggered
  ladderUsedLevels: Set<number>; // ladder pnl levels already used
}
interface ClosedTrade extends OpenTrade {
  exitTs: number;
  exitMcUsd: number;
  exitReason: ExitReason | 'KILLSTOP';
  pnlPct: number;            // realized NET total return % vs invested
  durationMin: number;
  totalInvestedUsd?: number;
  totalProceedsUsd?: number;
  netPnlUsd?: number;
  grossTotalProceedsUsd?: number;
  grossPnlUsd?: number;
  grossPnlPct?: number;
  costs?: {
    fee_bps_per_side: number;
    slippage_bps_per_side: number;
    cost_pct_per_side: number;
  };
}

const open = new Map<string, OpenTrade>();
const closed: ClosedTrade[] = [];
const evaluatedAt = new Map<string, number>(); // mint -> last eval timestamp (TTL-based dedup)
const lastEntryTsByMint = new Map<string, number>(); // for per-mint cooldown

// How often we are allowed to RE-evaluate the same mint
const REEVAL_AFTER_SEC = Number(process.env.PAPER_REEVAL_AFTER_SEC ||
  (STRATEGY_KIND === 'dip' || (STRATEGY_KIND === 'fresh_validated' && USE_DIP_ENTRY) ? 60 : 300));

function shouldEvaluate(mint: string): boolean {
  const last = evaluatedAt.get(mint) || 0;
  if (Date.now() - last < REEVAL_AFTER_SEC * 1000) return false;
  evaluatedAt.set(mint, Date.now());
  return true;
}

interface PendingFollowup {
  mint: string;
  symbol: string;
  entryTs: number;
  entryPrice: number;
  entryMarketPrice: number;
  metricType: 'mc' | 'price';
  source?: string;
  offsetMin: number;
  dueTs: number;
}
const pendingFollowups: PendingFollowup[] = [];
const completedFollowupKeys = new Set<string>();
const fkey = (mint: string, entryTs: number, offsetMin: number) => `${mint}|${entryTs}|${offsetMin}`;

function schedulePendingFollowups(args: { mint: string; symbol: string; entryTs: number; entryPrice: number; entryMarketPrice: number; metricType: 'mc' | 'price'; source?: string }) {
  if (!FOLLOWUP_ENABLED) return;
  for (const offset of FOLLOWUP_OFFSETS_MIN) {
    const key = fkey(args.mint, args.entryTs, offset);
    if (completedFollowupKeys.has(key)) continue;
    pendingFollowups.push({
      mint: args.mint,
      symbol: args.symbol,
      entryTs: args.entryTs,
      entryPrice: args.entryPrice,
      entryMarketPrice: args.entryMarketPrice,
      metricType: args.metricType,
      source: args.source,
      offsetMin: offset,
      dueTs: args.entryTs + offset * 60_000,
    });
  }
}

/**
 * Append-only JSONL. For `open` and `close` we fsync so a crash right after
 * a trade line does not lose the record on a machine with write caching.
 * Callers must write the full `open` row *before* `open.set` (see discovery paths).
 */
function append(
  event: Record<string, any>,
  opts?: { sync?: boolean },
): void {
  try {
    const payload: any = { ts: Date.now(), strategyId: STRATEGY_ID, ...event };
    // serialize Set objects (legs/ladder used markers) — JSON cannot do it natively
    if (payload.dcaUsedLevels instanceof Set) payload.dcaUsedLevels = [...payload.dcaUsedLevels];
    if (payload.ladderUsedLevels instanceof Set) payload.ladderUsedLevels = [...payload.ladderUsedLevels];
    const line = JSON.stringify(payload) + '\n';
    const sync = opts?.sync ?? (payload.kind === 'open' || payload.kind === 'close');
    ensureStoreDir();
    if (sync) {
      const fd = fs.openSync(STORE_PATH, 'a');
      try {
        fs.writeSync(fd, line, 0, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.appendFileSync(STORE_PATH, line);
    }
  } catch (err) {
    console.warn(`store write failed: ${err}`);
  }
}

function makeOpenTradeFromEntry(args: {
  mint: string; symbol: string; lane: Lane; source?: string; metricType: 'mc' | 'price';
  entryPrice: number; entryMetrics: Metrics;
}): OpenTrade {
  const sizeUsd = POSITION_USD;
  const marketPrice = args.entryPrice;
  const effectivePrice = effBuy(marketPrice);
  const firstLeg: PositionLeg = {
    ts: Date.now(),
    price: effectivePrice,
    marketPrice,
    sizeUsd,
    reason: 'open',
  };
  return {
    mint: args.mint,
    symbol: args.symbol,
    lane: args.lane,
    source: args.source,
    metricType: args.metricType,
    entryTs: Date.now(),
    entryMcUsd: effectivePrice,
    entryMetrics: args.entryMetrics,
    peakMcUsd: effectivePrice,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [firstLeg],
    partialSells: [],
    totalInvestedUsd: sizeUsd,
    avgEntry: effectivePrice,
    avgEntryMarket: marketPrice,
    remainingFraction: 1,
    dcaUsedLevels: new Set<number>(),
    ladderUsedLevels: new Set<number>(),
  };
}

// Pre-entry dynamics — три снимка состояния монеты (30m/10m/0m до входа)
// чтобы модель/анализ видели не статику, а ТРАЕКТОРИЮ.
interface PreEntryDynamics {
  holders_30m_ago: number;
  holders_10m_ago: number;
  holders_now: number;
  holders_delta_30_to_now: number;     // delta count (now - 30m_ago)
  holders_delta_10_to_now: number;
  vol5m_30m_ago_usd: number;
  vol5m_10m_ago_usd: number;
  vol5m_now_usd: number;
  vol_growth_30m_pct: number | null;   // % change in 5m window vs 30m ago
  vol_growth_10m_pct: number | null;
  bs_5m_30m_ago: number | null;
  bs_5m_10m_ago: number | null;
  bs_5m_now: number | null;
  price_30m_ago: number | null;
  price_10m_ago: number | null;
  price_now: number | null;
  price_growth_30m_pct: number | null;
  price_growth_10m_pct: number | null;
  trend_holders: 'rising' | 'flat' | 'falling' | 'unknown';
  trend_volume: 'rising' | 'flat' | 'falling' | 'unknown';
  trend_price: 'rising' | 'flat' | 'falling' | 'unknown';
}

function classifyTrend(curr: number, prev: number): 'rising' | 'flat' | 'falling' | 'unknown' {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev <= 0) return 'unknown';
  const r = (curr / prev) - 1;
  if (r >= 0.10) return 'rising';
  if (r <= -0.10) return 'falling';
  return 'flat';
}

async function fetchPreEntryDynamics(mint: string, anchorTs: number): Promise<PreEntryDynamics | null> {
  try {
    const safeMint = mint.replace(/'/g, "''");
    const anchorIso = new Date(anchorTs).toISOString();
    const r: any = await db.execute(dsql.raw(`
      SELECT
        COUNT(DISTINCT wallet) FILTER (
          WHERE block_time <= '${anchorIso}'::timestamptz - interval '30 minutes' AND side='buy'
        )::int AS holders_30m_ago,
        COUNT(DISTINCT wallet) FILTER (
          WHERE block_time <= '${anchorIso}'::timestamptz - interval '10 minutes' AND side='buy'
        )::int AS holders_10m_ago,
        COUNT(DISTINCT wallet) FILTER (
          WHERE block_time <= '${anchorIso}'::timestamptz AND side='buy'
        )::int AS holders_now,

        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '35 minutes' AND '${anchorIso}'::timestamptz - interval '30 minutes'
        ), 0)::float AS vol5m_30m_ago,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '15 minutes' AND '${anchorIso}'::timestamptz - interval '10 minutes'
        ), 0)::float AS vol5m_10m_ago,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '5 minutes' AND '${anchorIso}'::timestamptz
        ), 0)::float AS vol5m_now,

        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '35 minutes' AND '${anchorIso}'::timestamptz - interval '30 minutes' AND side='buy'
        ), 0)::float AS buy_30m,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '35 minutes' AND '${anchorIso}'::timestamptz - interval '30 minutes' AND side='sell'
        ), 0)::float AS sell_30m,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '15 minutes' AND '${anchorIso}'::timestamptz - interval '10 minutes' AND side='buy'
        ), 0)::float AS buy_10m,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '15 minutes' AND '${anchorIso}'::timestamptz - interval '10 minutes' AND side='sell'
        ), 0)::float AS sell_10m,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '5 minutes' AND '${anchorIso}'::timestamptz AND side='buy'
        ), 0)::float AS buy_now,
        COALESCE(SUM(amount_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '5 minutes' AND '${anchorIso}'::timestamptz AND side='sell'
        ), 0)::float AS sell_now,

        AVG(price_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '32 minutes' AND '${anchorIso}'::timestamptz - interval '28 minutes' AND price_usd > 0
        )::float AS price_30m_ago,
        AVG(price_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '12 minutes' AND '${anchorIso}'::timestamptz - interval '8 minutes' AND price_usd > 0
        )::float AS price_10m_ago,
        AVG(price_usd) FILTER (
          WHERE block_time BETWEEN '${anchorIso}'::timestamptz - interval '2 minutes' AND '${anchorIso}'::timestamptz AND price_usd > 0
        )::float AS price_now
      FROM swaps
      WHERE base_mint = '${safeMint}'
        AND block_time >= '${anchorIso}'::timestamptz - interval '40 minutes'
        AND block_time <= '${anchorIso}'::timestamptz
    `));
    const rows: any[] = Array.isArray(r) ? r : (r.rows ?? []);
    const x = rows[0];
    if (!x) return null;

    const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const numOrNull = (v: any) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);

    const holders_now = num(x.holders_now);
    const holders_10 = num(x.holders_10m_ago);
    const holders_30 = num(x.holders_30m_ago);
    const vol_now = num(x.vol5m_now);
    const vol_10 = num(x.vol5m_10m_ago);
    const vol_30 = num(x.vol5m_30m_ago);

    const bsRatio = (buy: number, sell: number): number | null => {
      const b = num(buy), s = num(sell);
      if (b + s <= 0) return null;
      if (s === 0) return b > 0 ? 99 : null;
      return +(b / s).toFixed(3);
    };
    const bs_now = bsRatio(num(x.buy_now), num(x.sell_now));
    const bs_10 = bsRatio(num(x.buy_10m), num(x.sell_10m));
    const bs_30 = bsRatio(num(x.buy_30m), num(x.sell_30m));

    const p_now = numOrNull(x.price_now);
    const p_10 = numOrNull(x.price_10m_ago);
    const p_30 = numOrNull(x.price_30m_ago);
    const pctChange = (curr: number | null, prev: number | null): number | null => {
      if (curr === null || prev === null || prev <= 0) return null;
      return +(((curr / prev) - 1) * 100).toFixed(2);
    };

    return {
      holders_30m_ago: holders_30,
      holders_10m_ago: holders_10,
      holders_now,
      holders_delta_30_to_now: holders_now - holders_30,
      holders_delta_10_to_now: holders_now - holders_10,
      vol5m_30m_ago_usd: +vol_30.toFixed(2),
      vol5m_10m_ago_usd: +vol_10.toFixed(2),
      vol5m_now_usd: +vol_now.toFixed(2),
      vol_growth_30m_pct: pctChange(vol_now, vol_30),
      vol_growth_10m_pct: pctChange(vol_now, vol_10),
      bs_5m_30m_ago: bs_30,
      bs_5m_10m_ago: bs_10,
      bs_5m_now: bs_now,
      price_30m_ago: p_30 !== null ? +p_30.toFixed(10) : null,
      price_10m_ago: p_10 !== null ? +p_10.toFixed(10) : null,
      price_now: p_now !== null ? +p_now.toFixed(10) : null,
      price_growth_30m_pct: pctChange(p_now, p_30),
      price_growth_10m_pct: pctChange(p_now, p_10),
      trend_holders: classifyTrend(holders_now, holders_30),
      trend_volume: classifyTrend(vol_now, vol_30),
      trend_price: p_now !== null && p_30 !== null ? classifyTrend(p_now, p_30) : 'unknown',
    };
  } catch (err) {
    console.warn(`fetchPreEntryDynamics failed for ${mint}: ${err}`);
    return null;
  }
}

// =====================================================================
// WHALE ANALYSIS (etap 5) — кто только что слил красную свечу:
//   creator-fud / single capitulation / group pressure / DCA-seller cadence
// =====================================================================
type SellerProfile = 'capitulator' | 'dca_predictable' | 'dca_aggressive' | 'panic_random' | 'unknown';

interface WhaleSeller {
  wallet: string;
  amount_usd: number;
  pct_of_position_dumped: number; // sell_amount / total_buy_on_mint
  pct_total_dumped_now: number;   // total_sells_on_mint / total_buys_on_mint
  is_creator: boolean;
  profile: SellerProfile;
  n_sells_24h: number;
  median_interval_min: number | null;
  median_chunk_usd: number | null;
}

interface WhaleAnalysis {
  enabled: boolean;
  creator_wallet: string | null;
  creator_dumped_pct: number;     // % of creator's total buy that they sold within lookback
  creator_dump_block: boolean;
  large_sells: WhaleSeller[];
  single_whale_capitulation: boolean;
  group_sell_pressure: boolean;
  dca_predictable_present: boolean;
  dca_aggressive_present: boolean;
  trigger_fired: 'whale_capitulation' | 'group_pressure' | 'dca_predictable' | null;
  block_reasons: string[];
}

function shortWallet(w: string | null | undefined): string {
  if (!w) return '';
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

function classifyProfile(args: {
  amount_usd: number;
  pctDumpedNow: number;
  nSells24h: number;
  medianIntervalMin: number | null;
  medianChunkUsd: number | null;
}): SellerProfile {
  const { amount_usd, pctDumpedNow, nSells24h, medianIntervalMin, medianChunkUsd } = args;
  if (
    nSells24h >= WHALE.DCA_AGGR_MIN_SELLS_24H &&
    medianIntervalMin !== null &&
    medianIntervalMin < WHALE.DCA_AGGR_MAX_INTERVAL_MIN
  ) return 'dca_aggressive';
  if (
    nSells24h >= WHALE.DCA_PRED_MIN_SELLS_24H &&
    (medianIntervalMin ?? 0) >= WHALE.DCA_PRED_MIN_INTERVAL_MIN &&
    (medianChunkUsd ?? 0) >= WHALE.DCA_PRED_MIN_CHUNK_USD
  ) return 'dca_predictable';
  if (pctDumpedNow >= WHALE.CAPITULATION_PCT && amount_usd >= WHALE.LARGE_SELL_USD) return 'capitulator';
  if (nSells24h <= 1) return 'panic_random';
  return 'unknown';
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function fetchWhaleAnalysis(mint: string): Promise<WhaleAnalysis> {
  const empty: WhaleAnalysis = {
    enabled: WHALE.ENABLED,
    creator_wallet: null,
    creator_dumped_pct: 0,
    creator_dump_block: false,
    large_sells: [],
    single_whale_capitulation: false,
    group_sell_pressure: false,
    dca_predictable_present: false,
    dca_aggressive_present: false,
    trigger_fired: null,
    block_reasons: [],
  };
  if (!WHALE.ENABLED) return empty;

  try {
    const safeMint = mint.replace(/'/g, "''");

    // Q1: creator (first buyer) + recent large sells
    const r1: any = await db.execute(dsql.raw(`
      WITH creator AS (
        SELECT wallet
        FROM swaps
        WHERE base_mint = '${safeMint}' AND side = 'buy'
        ORDER BY block_time ASC
        LIMIT 1
      ),
      large_sells AS (
        SELECT wallet, amount_usd::float AS amount_usd, block_time
        FROM swaps
        WHERE base_mint = '${safeMint}'
          AND side = 'sell'
          AND amount_usd >= ${WHALE.LARGE_SELL_USD}
          AND block_time >= now() - interval '${WHALE.RECENT_LOOKBACK_MIN} minutes'
        ORDER BY amount_usd DESC
        LIMIT 20
      )
      SELECT
        (SELECT wallet FROM creator) AS creator_wallet,
        (SELECT json_agg(row_to_json(ls)) FROM large_sells ls) AS sells
    `));
    const r1rows: any[] = Array.isArray(r1) ? r1 : (r1.rows ?? []);
    const head = r1rows[0] || {};
    const creatorWallet: string | null = head.creator_wallet ?? null;
    const sells: Array<{ wallet: string; amount_usd: number; block_time: any }> = Array.isArray(head.sells) ? head.sells : [];

    // Q2 (parallel): per-wallet enrichment
    const sellerWallets = [...new Set(sells.map((s) => s.wallet))];
    const enrichments = await Promise.all(sellerWallets.map(async (wallet) => {
      try {
        const safeW = wallet.replace(/'/g, "''");
        const r2: any = await db.execute(dsql.raw(`
          SELECT
            COALESCE(SUM(amount_usd) FILTER (WHERE base_mint = '${safeMint}' AND side = 'buy'), 0)::float AS total_buy_on_mint,
            COALESCE(SUM(amount_usd) FILTER (WHERE base_mint = '${safeMint}' AND side = 'sell'), 0)::float AS total_sell_on_mint,
            COUNT(*) FILTER (WHERE side = 'sell' AND block_time >= now() - interval '24 hours')::int AS n_sells_24h
          FROM swaps
          WHERE wallet = '${safeW}'
            AND block_time >= now() - interval '24 hours'
        `));
        const r2rows: any[] = Array.isArray(r2) ? r2 : (r2.rows ?? []);
        const baseInfo = r2rows[0] || { total_buy_on_mint: 0, total_sell_on_mint: 0, n_sells_24h: 0 };
        // intervals + chunks (separate small query to avoid huge GROUP BY)
        const r3: any = await db.execute(dsql.raw(`
          SELECT block_time, amount_usd::float AS amount_usd
          FROM swaps
          WHERE wallet = '${safeW}'
            AND side = 'sell'
            AND block_time >= now() - interval '24 hours'
          ORDER BY block_time ASC
        `));
        const r3rows: any[] = Array.isArray(r3) ? r3 : (r3.rows ?? []);
        const chunks = r3rows.map((r) => Number(r.amount_usd ?? 0)).filter((x) => Number.isFinite(x));
        const intervalsMin: number[] = [];
        for (let i = 1; i < r3rows.length; i++) {
          const prev = new Date(r3rows[i - 1].block_time).getTime();
          const curr = new Date(r3rows[i].block_time).getTime();
          if (curr > prev) intervalsMin.push((curr - prev) / 60_000);
        }
        return {
          wallet,
          total_buy_on_mint: Number(baseInfo.total_buy_on_mint || 0),
          total_sell_on_mint: Number(baseInfo.total_sell_on_mint || 0),
          n_sells_24h: Number(baseInfo.n_sells_24h || 0),
          median_chunk_usd: median(chunks),
          median_interval_min: median(intervalsMin),
        };
      } catch (err) {
        console.warn(`whale enrich failed for ${wallet}: ${err}`);
        return null;
      }
    }));
    const byWallet = new Map<string, NonNullable<typeof enrichments[number]>>();
    for (const e of enrichments) if (e) byWallet.set(e.wallet, e);

    const largeSellersOut: WhaleSeller[] = [];
    let groupSumUsd = 0;
    let groupSellersCount = 0;
    let dcaPredictablePresent = false;
    let dcaAggressivePresent = false;
    let singleCapitulation = false;

    for (const sell of sells) {
      const enr = byWallet.get(sell.wallet) || { total_buy_on_mint: 0, total_sell_on_mint: 0, n_sells_24h: 0, median_chunk_usd: null, median_interval_min: null };
      const totalBuy = enr.total_buy_on_mint || 0;
      const totalSell = enr.total_sell_on_mint || 0;
      const pctDumpedNow = totalBuy > 0 ? Math.min(1, totalSell / totalBuy) : 0;
      const pctOfPositionThis = totalBuy > 0 ? Math.min(1, sell.amount_usd / totalBuy) : 0;
      const profile = classifyProfile({
        amount_usd: sell.amount_usd,
        pctDumpedNow,
        nSells24h: enr.n_sells_24h,
        medianIntervalMin: enr.median_interval_min,
        medianChunkUsd: enr.median_chunk_usd,
      });
      const isCreator = creatorWallet === sell.wallet;
      const seller: WhaleSeller = {
        wallet: shortWallet(sell.wallet),
        amount_usd: +Number(sell.amount_usd).toFixed(2),
        pct_of_position_dumped: +pctOfPositionThis.toFixed(3),
        pct_total_dumped_now: +pctDumpedNow.toFixed(3),
        is_creator: isCreator,
        profile,
        n_sells_24h: enr.n_sells_24h,
        median_interval_min: enr.median_interval_min !== null ? +enr.median_interval_min.toFixed(1) : null,
        median_chunk_usd: enr.median_chunk_usd !== null ? +enr.median_chunk_usd.toFixed(0) : null,
      };
      largeSellersOut.push(seller);

      if (!isCreator) {
        if (profile === 'capitulator') singleCapitulation = true;
        if (profile === 'dca_predictable') dcaPredictablePresent = true;
        if (profile === 'dca_aggressive') dcaAggressivePresent = true;
        // group: считаем только тех, кто сбросил >= GROUP_DUMP_PCT этой свечой
        if (pctOfPositionThis >= WHALE.GROUP_DUMP_PCT) {
          groupSumUsd += sell.amount_usd;
          groupSellersCount += 1;
        }
      }
    }
    const groupPressure = groupSumUsd >= WHALE.GROUP_SELL_USD && groupSellersCount >= WHALE.GROUP_MIN_SELLERS;

    // creator dump check
    let creatorDumpedPct = 0;
    let creatorBlock = false;
    if (creatorWallet) {
      try {
        const safeCreator = creatorWallet.replace(/'/g, "''");
        const r4: any = await db.execute(dsql.raw(`
          SELECT
            COALESCE(SUM(amount_usd) FILTER (WHERE side = 'buy'), 0)::float AS total_buy,
            COALESCE(SUM(amount_usd) FILTER (
              WHERE side = 'sell' AND block_time >= now() - interval '${WHALE.CREATOR_DUMP_LOOKBACK_MIN} minutes'
            ), 0)::float AS recent_sell
          FROM swaps
          WHERE base_mint = '${safeMint}' AND wallet = '${safeCreator}'
        `));
        const r4rows: any[] = Array.isArray(r4) ? r4 : (r4.rows ?? []);
        const cb = Number(r4rows[0]?.total_buy ?? 0);
        const rs = Number(r4rows[0]?.recent_sell ?? 0);
        creatorDumpedPct = cb > 0 ? rs / cb : 0;
        if (
          WHALE.BLOCK_CREATOR_DUMP &&
          creatorDumpedPct >= WHALE.CREATOR_DUMP_MIN_PCT &&
          creatorDumpedPct <= WHALE.CREATOR_DUMP_MAX_PCT
        ) creatorBlock = true;
      } catch (err) {
        console.warn(`creator analysis failed for ${mint}: ${err}`);
      }
    }

    // decide trigger
    let trigger: WhaleAnalysis['trigger_fired'] = null;
    const blockReasons: string[] = [];
    if (creatorBlock) blockReasons.push(`creator_dumping_${(creatorDumpedPct * 100).toFixed(0)}%`);
    if (dcaAggressivePresent) blockReasons.push('dca_aggressive_present');
    if (singleCapitulation && !blockReasons.length) trigger = 'whale_capitulation';
    else if (groupPressure && !blockReasons.length) trigger = 'group_pressure';
    else if (dcaPredictablePresent && !blockReasons.length) trigger = 'dca_predictable';

    return {
      enabled: true,
      creator_wallet: creatorWallet ? shortWallet(creatorWallet) : null,
      creator_dumped_pct: +creatorDumpedPct.toFixed(3),
      creator_dump_block: creatorBlock,
      large_sells: largeSellersOut,
      single_whale_capitulation: singleCapitulation,
      group_sell_pressure: groupPressure,
      dca_predictable_present: dcaPredictablePresent,
      dca_aggressive_present: dcaAggressivePresent,
      trigger_fired: trigger,
      block_reasons: blockReasons,
    };
  } catch (err) {
    console.warn(`fetchWhaleAnalysis failed for ${mint}: ${err}`);
    return empty;
  }
}

/** Как у dip: блок creator / агр. DCA; опц. require «knife» trigger */
function rejectReasonsForFreshWhale(whale: WhaleAnalysis | null): string[] {
  if (!whale || !whale.enabled) return [];
  const r: string[] = [];
  if (whale.creator_dump_block) r.push(`creator_dumping_${(whale.creator_dumped_pct * 100).toFixed(0)}%`);
  if (whale.dca_aggressive_present) r.push('dca_aggressive_seller');
  const requireTrig = process.env.PAPER_FV_REQUIRE_WHALE_TRIGGER === '1';
  if (requireTrig && !whale.trigger_fired && !r.length) r.push('no_whale_trigger');
  return r;
}

async function fetchContextSwaps(mint: string, beforeTs: number, limit = CONTEXT_SWAPS_LIMIT): Promise<Array<{ ts: number; side: string; amount_usd: number; price_usd: number; wallet?: string }>> {
  if (!CONTEXT_SWAPS_ENABLED) return [];
  try {
    const safeMint = mint.replace(/'/g, "''");
    const beforeIso = new Date(beforeTs).toISOString();
    const r: any = await db.execute(dsql.raw(`
      SELECT block_time AS ts, side, amount_usd::float AS amount_usd, price_usd::float AS price_usd, wallet
      FROM swaps
      WHERE base_mint = '${safeMint}'
        AND block_time <= '${beforeIso}'::timestamptz
      ORDER BY block_time DESC
      LIMIT ${Math.max(1, Math.min(50, limit))}
    `));
    const rows: any[] = Array.isArray(r) ? r : (r.rows ?? []);
    return rows.map((row) => ({
      ts: new Date(row.ts).getTime(),
      side: String(row.side ?? ''),
      amount_usd: Number(row.amount_usd ?? 0),
      price_usd: Number(row.price_usd ?? 0),
      wallet: row.wallet ? `${String(row.wallet).slice(0, 6)}...${String(row.wallet).slice(-4)}` : undefined,
    })).reverse();
  } catch (err) {
    console.warn(`fetchContextSwaps failed for ${mint}: ${err}`);
    return [];
  }
}

function rehydrateLegs(o: OpenTrade): OpenTrade {
  if (!o.legs || !o.legs.length) {
    o.legs = [{ ts: o.entryTs, price: o.entryMcUsd, marketPrice: o.entryMcUsd, sizeUsd: POSITION_USD, reason: 'open' }];
  } else {
    for (const leg of o.legs) if (typeof leg.marketPrice !== 'number') leg.marketPrice = leg.price;
  }
  if (!o.partialSells) o.partialSells = [];
  for (const ps of o.partialSells) {
    if (typeof ps.marketPrice !== 'number') ps.marketPrice = ps.price;
    if (typeof ps.grossProceedsUsd !== 'number') ps.grossProceedsUsd = ps.proceedsUsd;
    if (typeof ps.grossPnlUsd !== 'number') ps.grossPnlUsd = ps.pnlUsd;
  }
  if (typeof o.totalInvestedUsd !== 'number') o.totalInvestedUsd = o.legs.reduce((s, l) => s + l.sizeUsd, 0);
  if (typeof o.avgEntry !== 'number' || !o.avgEntry) {
    const totalSize = o.legs.reduce((s, l) => s + l.sizeUsd, 0);
    const num = o.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
    o.avgEntry = totalSize > 0 ? num / totalSize : o.entryMcUsd;
  }
  if (typeof o.avgEntryMarket !== 'number' || !o.avgEntryMarket) {
    const totalSize = o.legs.reduce((s, l) => s + l.sizeUsd, 0);
    const num = o.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
    o.avgEntryMarket = totalSize > 0 ? num / totalSize : o.entryMcUsd;
  }
  if (typeof o.remainingFraction !== 'number') {
    let r = 1;
    for (const ps of o.partialSells) r *= (1 - (ps.sellFraction || 0));
    o.remainingFraction = Math.max(0, r);
  }
  if (!(o.dcaUsedLevels instanceof Set)) o.dcaUsedLevels = new Set(Array.isArray((o as any).dcaUsedLevels) ? (o as any).dcaUsedLevels : []);
  if (!(o.ladderUsedLevels instanceof Set)) o.ladderUsedLevels = new Set(Array.isArray((o as any).ladderUsedLevels) ? (o as any).ladderUsedLevels : []);
  return o;
}

function loadStore(): void {
  if (!fs.existsSync(STORE_PATH)) return;
  const lines = fs.readFileSync(STORE_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln);
      if (e.kind === 'eval') {
        // bring TTL into a sane state on restore so we don't re-eval the same mint immediately
        const ts = Number(e.ts || 0);
        const prev = evaluatedAt.get(e.mint) || 0;
        if (ts > prev) evaluatedAt.set(e.mint, ts);
      }
      if (e.kind === 'followup_snapshot' && e.mint && typeof e.entryTs === 'number' && typeof e.offsetMin === 'number') {
        completedFollowupKeys.add(fkey(e.mint, e.entryTs, e.offsetMin));
      }
      if (e.kind === 'open' && e.mint && typeof e.entryTs === 'number') {
        const prev = lastEntryTsByMint.get(e.mint) || 0;
        if (e.entryTs > prev) lastEntryTsByMint.set(e.mint, e.entryTs);
      }
      if (e.kind === 'open') {
        const restored: OpenTrade = {
          mint: e.mint, symbol: e.symbol, entryTs: e.entryTs, entryMcUsd: e.entryMcUsd,
          lane: e.lane || 'launchpad_early',
          source: e.source,
          metricType: e.metricType || 'mc',
          entryMetrics: e.entryMetrics,
          peakMcUsd: e.entryMcUsd,
          peakPnlPct: 0,
          trailingArmed: false,
          legs: e.legs,
          partialSells: e.partialSells || [],
          totalInvestedUsd: e.totalInvestedUsd,
          avgEntry: e.avgEntry,
          avgEntryMarket: e.avgEntryMarket,
          remainingFraction: e.remainingFraction,
          dcaUsedLevels: new Set(Array.isArray(e.dcaUsedLevels) ? e.dcaUsedLevels : []),
          ladderUsedLevels: new Set(Array.isArray(e.ladderUsedLevels) ? e.ladderUsedLevels : []),
        } as any;
        open.set(e.mint, rehydrateLegs(restored));

        // pending followups based on entry timestamp (can also fire after close)
        const firstLeg = (e.legs && e.legs[0]) || { price: e.entryMcUsd, marketPrice: e.entryMcUsd };
        schedulePendingFollowups({
          mint: e.mint,
          symbol: e.symbol,
          entryTs: e.entryTs,
          entryPrice: firstLeg.price ?? e.entryMcUsd,
          entryMarketPrice: firstLeg.marketPrice ?? e.entryMcUsd,
          metricType: (e.metricType as 'mc' | 'price') || 'mc',
          source: e.source,
        });
      }
      if (e.kind === 'dca_add' && open.has(e.mint)) {
        const ot = open.get(e.mint)!;
        ot.legs.push({
          ts: e.ts,
          price: e.price,
          marketPrice: typeof e.marketPrice === 'number' ? e.marketPrice : e.price,
          sizeUsd: e.sizeUsd,
          reason: 'dca',
          triggerPct: e.triggerPct,
        });
        ot.totalInvestedUsd += e.sizeUsd;
        const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
        ot.avgEntry = num / ot.totalInvestedUsd;
        const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
        ot.avgEntryMarket = numM / ot.totalInvestedUsd;
        if (typeof e.triggerPct === 'number') ot.dcaUsedLevels.add(e.triggerPct);
      }
      if (e.kind === 'partial_sell' && open.has(e.mint)) {
        const ot = open.get(e.mint)!;
        ot.partialSells.push({
          ts: e.ts,
          price: e.price,
          marketPrice: typeof e.marketPrice === 'number' ? e.marketPrice : e.price,
          sellFraction: e.sellFraction,
          reason: e.reason,
          proceedsUsd: e.proceedsUsd,
          grossProceedsUsd: typeof e.grossProceedsUsd === 'number' ? e.grossProceedsUsd : e.proceedsUsd,
          pnlUsd: e.pnlUsd,
          grossPnlUsd: typeof e.grossPnlUsd === 'number' ? e.grossPnlUsd : e.pnlUsd,
        });
        ot.remainingFraction = Math.max(0, ot.remainingFraction * (1 - e.sellFraction));
        if (typeof e.ladderPnlPct === 'number') ot.ladderUsedLevels.add(e.ladderPnlPct);
      }
      if (e.kind === 'close') {
        open.delete(e.mint);
        closed.push(e as ClosedTrade);
      }
      if (e.kind === 'peak' && open.has(e.mint)) {
        const ot = open.get(e.mint)!;
        ot.peakMcUsd = Math.max(ot.peakMcUsd, e.peakMcUsd);
        ot.peakPnlPct = Math.max(ot.peakPnlPct, e.peakPnlPct ?? 0);
        ot.trailingArmed = ot.trailingArmed || !!e.trailingArmed;
        // Чтобы после рестарта peak event-ы не спамили из-за сравнения с -Infinity.
        (ot as any)._lastPersistedPeak = Math.max((ot as any)._lastPersistedPeak ?? -Infinity, e.peakPnlPct ?? 0);
      }
    } catch {}
  }
  // restore stats counters from disk so что pm2 restart не "обнуляет" видимую статистику
  for (const ct of closed) {
    if (ct.exitReason && stats.closed[ct.exitReason] != null) stats.closed[ct.exitReason]++;
  }
  console.log(`[store] loaded (${STRATEGY_ID}): ${evaluatedAt.size} evaluated mints (TTL=${REEVAL_AFTER_SEC}s), ${open.size} open, ${closed.length} closed`);
  console.log(`[store] exits restored: TP=${stats.closed.TP} SL=${stats.closed.SL} TRAIL=${stats.closed.TRAIL} TIMEOUT=${stats.closed.TIMEOUT} NO_DATA=${stats.closed.NO_DATA}`);
}

// =====================================================================
// DISCOVERY: один SQL — fresh mints + agregаты их swaps в окне [2..7] мин
// =====================================================================
interface FreshAggRow {
  mint: string; symbol: string; first_seen_at: Date;
  holder_count: number;
  token_age_min: number;
  unique_buyers: number; unique_sellers: number;
  buy_usd: number; sell_usd: number; top_buyer_usd: number;
}

interface SnapshotCandidateRow {
  mint: string;
  symbol: string;
  ts: Date;
  launch_ts: Date | null;
  age_min: number | null;
  price_usd: number;
  liquidity_usd: number;
  volume_5m: number;
  buys_5m: number;
  sells_5m: number;
  market_cap_usd: number | null;
  source: string;
  holder_count: number;
  token_age_min: number;
}

interface DipContext {
  high_px: number;
  low_px: number;
}

async function fetchFreshAggregates(): Promise<FreshAggRow[]> {
  const r: any = await db.execute(dsql.raw(`
    WITH fresh AS (
      SELECT mint, symbol, first_seen_at, metadata
      FROM tokens
      WHERE first_seen_at < now() - interval '${DECISION_AGE_MIN} minutes'
        AND first_seen_at > now() - interval '${DECISION_AGE_MAX_MIN} minutes'
        AND metadata->>'source' IN ('pumpportal','moonshot','bonk')
    ),
    swaps_in_window AS (
      SELECT s.base_mint, s.wallet, s.side, s.amount_usd
      FROM swaps s
      JOIN fresh f ON s.base_mint = f.mint
      WHERE s.block_time >= f.first_seen_at + interval '${WINDOW_START_MIN} minutes'
        AND s.block_time <= f.first_seen_at + interval '${DECISION_AGE_MIN} minutes'
        AND s.amount_usd >= 5
    ),
    per_buyer AS (
      SELECT base_mint, wallet, SUM(amount_usd) AS w_usd
      FROM swaps_in_window
      WHERE side = 'buy'
      GROUP BY base_mint, wallet
    ),
    aggs AS (
      SELECT
        base_mint,
        COUNT(DISTINCT wallet) FILTER (WHERE side='buy')  AS unique_buyers,
        COUNT(DISTINCT wallet) FILTER (WHERE side='sell') AS unique_sellers,
        COALESCE(SUM(amount_usd) FILTER (WHERE side='buy'),  0) AS buy_usd,
        COALESCE(SUM(amount_usd) FILTER (WHERE side='sell'), 0) AS sell_usd
      FROM swaps_in_window
      GROUP BY base_mint
    ),
    tops AS (
      SELECT base_mint, MAX(w_usd) AS top_buyer_usd
      FROM per_buyer
      GROUP BY base_mint
    )
    SELECT
      f.mint, f.symbol, f.first_seen_at,
      0::int AS holder_count,
      EXTRACT(EPOCH FROM (now() - f.first_seen_at)) / 60.0 AS token_age_min,
      COALESCE(a.unique_buyers,  0)::int   AS unique_buyers,
      COALESCE(a.unique_sellers, 0)::int   AS unique_sellers,
      COALESCE(a.buy_usd,        0)::float AS buy_usd,
      COALESCE(a.sell_usd,       0)::float AS sell_usd,
      COALESCE(t.top_buyer_usd,  0)::float AS top_buyer_usd
    FROM fresh f
    LEFT JOIN aggs a ON a.base_mint = f.mint
    LEFT JOIN tops t ON t.base_mint = f.mint
    ORDER BY f.first_seen_at ASC
  `));
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function tableExists(name: string): Promise<boolean> {
  if ((tableExists as any)._cache?.has(name)) return (tableExists as any)._cache.get(name);
  if (!(tableExists as any)._cache) (tableExists as any)._cache = new Map<string, boolean>();
  const r: any = await db.execute(dsql.raw(`SELECT to_regclass('public.${name}') AS t`));
  const rows = Array.isArray(r) ? r : (r.rows ?? []);
  const ok = Boolean(rows[0]?.t);
  (tableExists as any)._cache.set(name, ok);
  return ok;
}

async function fetchSnapshotLaneCandidates(lane: Lane): Promise<SnapshotCandidateRow[]> {
  const cfg = lane === 'migration_event' ? LANE_MIGRATION : LANE_POST;
  const tables: Array<{ table: string; source: string }> = [];
  if (await tableExists('raydium_pair_snapshots')) tables.push({ table: 'raydium_pair_snapshots', source: 'raydium' });
  if (await tableExists('meteora_pair_snapshots')) tables.push({ table: 'meteora_pair_snapshots', source: 'meteora' });
  if (await tableExists('pumpswap_pair_snapshots')) tables.push({ table: 'pumpswap_pair_snapshots', source: 'pumpswap' });
  if (!tables.length) return [];

  const unions = tables.map((t) => `
    SELECT
      p.base_mint AS mint,
      COALESCE(tok.symbol, '?') AS symbol,
        0::int AS holder_count,
        EXTRACT(EPOCH FROM (now() - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
      p.ts,
      NULL::timestamptz AS launch_ts,
      EXTRACT(EPOCH FROM (p.ts - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS age_min,
      COALESCE(p.price_usd, 0)::float AS price_usd,
      COALESCE(p.liquidity_usd, 0)::float AS liquidity_usd,
      COALESCE(p.volume_5m, 0)::float AS volume_5m,
      COALESCE(p.buys_5m, 0)::int AS buys_5m,
      COALESCE(p.sells_5m, 0)::int AS sells_5m,
      COALESCE(p.market_cap_usd, p.fdv_usd, 0)::float AS market_cap_usd,
      '${t.source}'::text AS source
    FROM ${t.table} p
    LEFT JOIN tokens tok ON tok.mint = p.base_mint
    WHERE p.ts >= now() - interval '30 minutes'
      AND COALESCE(p.price_usd, 0) > 0
  `);

  const r: any = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions.join('\nUNION ALL\n')}
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY mint ORDER BY ts DESC) AS rn
      FROM raw
    )
    SELECT *
    FROM ranked
    WHERE rn = 1
      AND COALESCE(age_min, 0) >= ${cfg.MIN_AGE_MIN}
      ${cfg.MAX_AGE_MIN > 0 ? `AND COALESCE(age_min, 0) <= ${cfg.MAX_AGE_MIN}` : ''}
      AND liquidity_usd >= ${cfg.MIN_LIQ_USD}
      AND volume_5m >= ${cfg.MIN_VOL_5M_USD}
      AND buys_5m >= ${cfg.MIN_BUYS_5M}
      AND sells_5m >= ${cfg.MIN_SELLS_5M}
    ORDER BY ts DESC
    LIMIT 300
  `));
  return Array.isArray(r) ? r : (r.rows ?? []);
}

function computeMetrics(row: FreshAggRow, solUsd: number): Metrics {
  const sumBuySol = row.buy_usd / solUsd;
  const sumSellSol = row.sell_usd / solUsd;
  const topBuyerShare = row.buy_usd > 0 ? row.top_buyer_usd / row.buy_usd : 0;
  const bcProgress = Math.max(0, Math.min(1, (sumBuySol - sumSellSol) / BC_GRADUATION_SOL));
  return {
    uniqueBuyers: row.unique_buyers,
    uniqueSellers: row.unique_sellers,
    sumBuySol, sumSellSol, topBuyerShare, bcProgress,
  };
}

interface Verdict { pass: boolean; reasons: string[]; m: Metrics; }
function evaluate(m: Metrics): Verdict {
  const r: string[] = [];
  if (m.uniqueBuyers < FILTERS.MIN_UNIQUE_BUYERS) r.push(`buyers<${FILTERS.MIN_UNIQUE_BUYERS}`);
  if (m.sumBuySol < FILTERS.MIN_BUY_SOL) r.push(`buy_sol<${FILTERS.MIN_BUY_SOL}`);
  if (m.sumSellSol > 0 && m.sumBuySol / m.sumSellSol < FILTERS.MIN_BUY_SELL_RATIO) r.push(`bs<${FILTERS.MIN_BUY_SELL_RATIO}`);
  if (m.topBuyerShare > FILTERS.MAX_TOP_BUYER_SHARE) r.push(`top>${FILTERS.MAX_TOP_BUYER_SHARE * 100}%`);
  if (m.bcProgress < FILTERS.MIN_BC_PROGRESS) r.push(`bc<${FILTERS.MIN_BC_PROGRESS * 100}%`);
  if (m.bcProgress > FILTERS.MAX_BC_PROGRESS) r.push(`bc>${FILTERS.MAX_BC_PROGRESS * 100}%`);
  return { pass: r.length === 0, reasons: r, m };
}

function evaluateSnapshot(row: SnapshotCandidateRow, lane: Lane): { pass: boolean; reasons: string[] } {
  const cfg = lane === 'migration_event' ? LANE_MIGRATION : LANE_POST;
  const reasons: string[] = [];
  if (row.liquidity_usd < cfg.MIN_LIQ_USD) reasons.push(`liq<${cfg.MIN_LIQ_USD}`);
  if (row.volume_5m < cfg.MIN_VOL_5M_USD) reasons.push(`vol5m<${cfg.MIN_VOL_5M_USD}`);
  if (row.buys_5m < cfg.MIN_BUYS_5M) reasons.push(`buys5m<${cfg.MIN_BUYS_5M}`);
  if (row.sells_5m < cfg.MIN_SELLS_5M) reasons.push(`sells5m<${cfg.MIN_SELLS_5M}`);
  const bs = row.sells_5m > 0 ? row.buys_5m / row.sells_5m : row.buys_5m;
  if (bs < SNAPSHOT_MIN_BS) reasons.push(`bs<${SNAPSHOT_MIN_BS}`);
  return { pass: reasons.length === 0, reasons };
}

function globalGate(tokenAgeMin?: number | null, holderCount?: number | null): string[] {
  const reasons: string[] = [];
  const age = Number(tokenAgeMin ?? 0);
  const holders = Number(holderCount ?? 0);
  if (GLOBAL_MIN_TOKEN_AGE_MIN > 0 && age < GLOBAL_MIN_TOKEN_AGE_MIN) {
    reasons.push(`token_age<${GLOBAL_MIN_TOKEN_AGE_MIN}m`);
  }
  if (GLOBAL_MIN_HOLDER_COUNT > 0 && holders < GLOBAL_MIN_HOLDER_COUNT) {
    reasons.push(`holders<${GLOBAL_MIN_HOLDER_COUNT}`);
  }
  return reasons;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sourceSnapshotTable(source: string): string | null {
  if (source === 'raydium') return 'raydium_pair_snapshots';
  if (source === 'meteora') return 'meteora_pair_snapshots';
  return null;
}

async function fetchDipContextMap(rows: SnapshotCandidateRow[]): Promise<Map<string, DipContext>> {
  const map = new Map<string, DipContext>();
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const t = sourceSnapshotTable(r.source);
    if (!t) continue;
    const arr = byTable.get(t) ?? [];
    arr.push(r.mint);
    byTable.set(t, arr);
  }

  for (const [table, mintsRaw] of byTable.entries()) {
    const uniq = [...new Set(mintsRaw)];
    if (!uniq.length) continue;
    const mintsSql = uniq.map(sqlQuote).join(',');
    const q: any = await db.execute(dsql.raw(`
      SELECT
        base_mint AS mint,
        MAX(COALESCE(price_usd, 0))::float AS high_px,
        MIN(NULLIF(COALESCE(price_usd, 0), 0))::float AS low_px
      FROM ${table}
      WHERE ts >= now() - interval '${DIP.LOOKBACK_MIN} minutes'
        AND base_mint IN (${mintsSql})
      GROUP BY base_mint
    `));
    const out = Array.isArray(q) ? q : (q.rows ?? []);
    for (const r of out) {
      map.set(String(r.mint), { high_px: Number(r.high_px || 0), low_px: Number(r.low_px || 0) });
    }
  }
  return map;
}

function evaluateDip(row: SnapshotCandidateRow, ctx?: DipContext | null): { reasons: string[]; dipPct: number | null; impulsePct: number | null } {
  const reasons: string[] = [];
  if ((row.token_age_min ?? 0) < DIP.MIN_AGE_MIN) reasons.push(`dip_age<${DIP.MIN_AGE_MIN}m`);
  if (!ctx || !(ctx.high_px > 0)) return { reasons: [...reasons, 'dip_ctx_missing'], dipPct: null, impulsePct: null };

  const dipPct = ((row.price_usd / ctx.high_px) - 1) * 100;
  if (dipPct > DIP.MIN_DROP_PCT) reasons.push(`dip_not_deep_enough>${DIP.MIN_DROP_PCT}%`);
  if (dipPct < DIP.MAX_DROP_PCT) reasons.push(`dip_too_deep<${DIP.MAX_DROP_PCT}%`);

  const impulsePct = ctx.low_px > 0 ? ((ctx.high_px / ctx.low_px) - 1) * 100 : null;
  if ((impulsePct ?? 0) < DIP.MIN_IMPULSE_PCT) reasons.push(`impulse<${DIP.MIN_IMPULSE_PCT}%`);
  return { reasons, dipPct, impulsePct };
}

async function fetchCurrentMc(mint: string): Promise<{ mc: number; ath: number } | null> {
  const j: any = await fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`);
  if (!j) return null;
  return { mc: Number(j.usd_market_cap ?? 0), ath: Number(j.ath_market_cap ?? 0) };
}

async function fetchLatestSnapshotPrice(mint: string, source?: string): Promise<number | null> {
  const picks: string[] = [];
  if (source === 'raydium') picks.push('raydium_pair_snapshots');
  if (source === 'meteora') picks.push('meteora_pair_snapshots');
  if (!picks.length) picks.push('raydium_pair_snapshots', 'meteora_pair_snapshots');

  for (const t of picks) {
    if (!(await tableExists(t))) continue;
    const r: any = await db.execute(dsql.raw(`
      SELECT price_usd
      FROM ${t}
      WHERE base_mint = '${mint}'
      ORDER BY ts DESC
      LIMIT 1
    `));
    const rows = Array.isArray(r) ? r : (r.rows ?? []);
    const px = Number(rows[0]?.price_usd ?? 0);
    if (px > 0) return px;
  }
  return null;
}

// =====================================================================
// SMART LOTTERY discovery — uses our wallet atlas for early-buyer signal
// =====================================================================
interface SmartLotteryRow {
  mint: string;
  symbol: string;
  first_seen_at: Date;
  age_min: number;
  early_buyers: number;
  smart_buyers: number;
  scam_hits: number;
  smart_tags: string[];
  scam_tags: string[];
  total_buy_usd: number;
}

async function fetchSmartLotteryCandidates(): Promise<SmartLotteryRow[]> {
  const smartList = ATLAS_SMART_TAGS.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
  const scamList = ATLAS_SCAM_TAGS.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
  // По умолчанию берём все известные источники свежих токенов: pumpfun, moonshot, bonk
  // плюс post-mig DEX-ы (pumpswap/raydium/meteora/orca) и dex-screener seeds, плюс токены
  // без явного source (могли быть добавлены direct-lp-detector или sigseed-pipeline).
  const sourceList = (process.env.PAPER_SMART_SOURCES ||
    'pumpportal,moonshot,bonk,pumpswap,raydium,meteora,orca,dexscreener_seed,direct_lp')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const sourceFilter = process.env.PAPER_SMART_SOURCE_FILTER === '0'
    ? ''
    : `AND (metadata->>'source' IN (${sourceList}) OR metadata IS NULL OR metadata->>'source' IS NULL)`;
  const r: any = await db.execute(dsql.raw(`
    WITH fresh AS (
      SELECT mint, symbol, first_seen_at
      FROM tokens
      WHERE first_seen_at <= now() - interval '${SMART_LOTTERY.MIN_AGE_MIN} minutes'
        AND first_seen_at >= now() - interval '${SMART_LOTTERY.MAX_AGE_MIN} minutes'
        ${sourceFilter}
    ),
    early AS (
      SELECT s.base_mint AS mint, s.wallet, s.amount_usd, s.block_time, f.first_seen_at,
             ROW_NUMBER() OVER (PARTITION BY s.base_mint ORDER BY s.block_time ASC) AS rn
      FROM swaps s
      JOIN fresh f ON s.base_mint = f.mint
      WHERE s.side = 'buy'
        AND s.block_time <= f.first_seen_at + interval '${SMART_LOTTERY.WINDOW_MIN} minutes'
        AND s.amount_usd >= ${SMART_LOTTERY.MIN_AMOUNT_USD}
    ),
    early_top AS (
      SELECT * FROM early WHERE rn <= ${SMART_LOTTERY.EARLY_LIMIT}
    ),
    tagged AS (
      SELECT et.mint, et.wallet, et.amount_usd, ew.primary_tag
      FROM early_top et
      LEFT JOIN entity_wallets ew ON ew.wallet = et.wallet
    ),
    agg AS (
      SELECT mint,
             COUNT(*) AS early_buyers,
             COALESCE(SUM(amount_usd), 0)::float AS total_buy_usd,
             COUNT(*) FILTER (WHERE primary_tag IN (${smartList})) AS smart_buyers,
             COUNT(*) FILTER (WHERE primary_tag IN (${scamList})) AS scam_hits,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT primary_tag) FILTER (WHERE primary_tag IN (${smartList})), NULL) AS smart_tags,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT primary_tag) FILTER (WHERE primary_tag IN (${scamList})), NULL) AS scam_tags
      FROM tagged
      GROUP BY mint
    )
    SELECT f.mint, f.symbol, f.first_seen_at,
           EXTRACT(EPOCH FROM (now() - f.first_seen_at)) / 60.0 AS age_min,
           COALESCE(a.early_buyers, 0)::int AS early_buyers,
           COALESCE(a.smart_buyers, 0)::int AS smart_buyers,
           COALESCE(a.scam_hits, 0)::int AS scam_hits,
           COALESCE(a.smart_tags, '{}') AS smart_tags,
           COALESCE(a.scam_tags, '{}') AS scam_tags,
           COALESCE(a.total_buy_usd, 0)::float AS total_buy_usd
    FROM fresh f
    LEFT JOIN agg a ON a.mint = f.mint
    ORDER BY f.first_seen_at DESC
    LIMIT 300
  `));
  return Array.isArray(r) ? r : (r.rows ?? []);
}

function evaluateSmartLottery(row: SmartLotteryRow): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (row.smart_buyers <= 0) reasons.push('no_smart_signal');
  if (row.scam_hits > 0) reasons.push('scam_hit_in_early');
  if (row.early_buyers < 5) reasons.push('too_few_early_buyers<5');
  return { pass: reasons.length === 0, reasons };
}

// =====================================================================
// FRESH VALIDATED discovery — older fresh tokens with proven dynamics
// =====================================================================
interface FreshValidatedRow {
  mint: string;
  symbol: string;
  first_seen_at: Date;
  age_min: number;
  holders: number;
  price_now: number;
  price_at_early: number;
  growth_pct: number | null;
  buy_usd_5m: number;
  sell_usd_5m: number;
  buy_usd_1m: number;
  sell_usd_1m: number;
  total_buy_usd: number;
  top_buyer_share: number;
  liq_usd_proxy: number;
  has_scam: boolean;
  scam_tags: string[];
}

async function fetchFreshValidatedCandidates(): Promise<FreshValidatedRow[]> {
  const scamList = ATLAS_SCAM_TAGS.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
  const launchpadFilter = FRESH_VALIDATED.REQUIRE_LAUNCHPAD
    ? `AND metadata->>'source' IN ('pumpportal','moonshot','bonk')`
    : '';
  const maxAgeFilter =
    FRESH_VALIDATED.MAX_AGE_MIN > 0
      ? `AND first_seen_at >= now() - interval '${FRESH_VALIDATED.MAX_AGE_MIN} minutes'`
      : '';
  const r: any = await db.execute(dsql.raw(`
    WITH fresh AS (
      SELECT mint, symbol, first_seen_at
      FROM tokens
      WHERE first_seen_at <= now() - interval '${FRESH_VALIDATED.MIN_AGE_MIN} minutes'
        ${maxAgeFilter}
        ${launchpadFilter}
    ),
    sw AS (
      SELECT s.base_mint AS mint, s.wallet, s.side, s.amount_usd, s.price_usd, s.block_time,
             f.first_seen_at
      FROM swaps s
      JOIN fresh f ON s.base_mint = f.mint
    ),
    early AS (
      SELECT mint, MAX(price_usd)::float AS price_at_early
      FROM sw
      WHERE block_time BETWEEN first_seen_at + interval '${FRESH_VALIDATED.EARLY_WINDOW_FROM_MIN} minutes'
                           AND first_seen_at + interval '${FRESH_VALIDATED.EARLY_WINDOW_TO_MIN} minutes'
        AND COALESCE(price_usd, 0) > 0
      GROUP BY mint
    ),
    recent AS (
      SELECT mint,
             MAX(price_usd)::float AS price_now,
             COALESCE(SUM(amount_usd) FILTER (WHERE side='buy'), 0)::float AS buy_usd_5m,
             COALESCE(SUM(amount_usd) FILTER (WHERE side='sell'), 0)::float AS sell_usd_5m
      FROM sw
      WHERE block_time >= now() - interval '5 minutes'
      GROUP BY mint
    ),
    recent1m AS (
      SELECT mint,
             COALESCE(SUM(amount_usd) FILTER (WHERE side='buy'), 0)::float AS buy_usd_1m,
             COALESCE(SUM(amount_usd) FILTER (WHERE side='sell'), 0)::float AS sell_usd_1m
      FROM sw
      WHERE block_time >= now() - interval '1 minute'
      GROUP BY mint
    ),
    holders AS (
      SELECT mint, COUNT(DISTINCT wallet)::int AS holders
      FROM sw
      WHERE side = 'buy'
      GROUP BY mint
    ),
    per_buyer AS (
      SELECT mint, wallet, SUM(amount_usd) AS w_usd
      FROM sw
      WHERE side = 'buy'
      GROUP BY mint, wallet
    ),
    top_share AS (
      SELECT mint,
             MAX(w_usd)::float AS top_buyer_usd,
             SUM(w_usd)::float AS total_buy_usd
      FROM per_buyer
      GROUP BY mint
    ),
    scam_check AS (
      SELECT pb.mint,
             BOOL_OR(ew.primary_tag IN (${scamList})) AS has_scam,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT ew.primary_tag) FILTER (WHERE ew.primary_tag IN (${scamList})), NULL) AS scam_tags
      FROM per_buyer pb
      LEFT JOIN entity_wallets ew ON ew.wallet = pb.wallet
      GROUP BY pb.mint
    )
    SELECT f.mint, f.symbol, f.first_seen_at,
           EXTRACT(EPOCH FROM (now() - f.first_seen_at)) / 60.0 AS age_min,
           COALESCE(h.holders, 0) AS holders,
           COALESCE(rc.price_now, 0)::float AS price_now,
           COALESCE(e.price_at_early, 0)::float AS price_at_early,
           COALESCE(rc.buy_usd_5m, 0)::float AS buy_usd_5m,
           COALESCE(rc.sell_usd_5m, 0)::float AS sell_usd_5m,
           COALESCE(r1.buy_usd_1m, 0)::float AS buy_usd_1m,
           COALESCE(r1.sell_usd_1m, 0)::float AS sell_usd_1m,
           COALESCE(ts.total_buy_usd, 0)::float AS total_buy_usd,
           CASE WHEN COALESCE(ts.total_buy_usd, 0) > 0 THEN COALESCE(ts.top_buyer_usd, 0) / ts.total_buy_usd ELSE 0 END::float AS top_buyer_share,
           COALESCE(ts.total_buy_usd, 0)::float AS liq_usd_proxy,
           COALESCE(sc.has_scam, false) AS has_scam,
           COALESCE(sc.scam_tags, '{}') AS scam_tags
    FROM fresh f
    LEFT JOIN holders h ON h.mint = f.mint
    LEFT JOIN early e ON e.mint = f.mint
    LEFT JOIN recent rc ON rc.mint = f.mint
    LEFT JOIN recent1m r1 ON r1.mint = f.mint
    LEFT JOIN top_share ts ON ts.mint = f.mint
    LEFT JOIN scam_check sc ON sc.mint = f.mint
    ORDER BY f.first_seen_at DESC
    LIMIT 300
  `));
  const rows: any[] = Array.isArray(r) ? r : (r.rows ?? []);
  for (const row of rows) {
    const e = Number(row.price_at_early || 0);
    const n = Number(row.price_now || 0);
    row.growth_pct = e > 0 ? ((n / e) - 1) * 100 : null;
  }
  return rows as FreshValidatedRow[];
}

function evaluateFreshValidated(row: FreshValidatedRow): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (row.holders < FRESH_VALIDATED.MIN_HOLDERS) reasons.push(`holders<${FRESH_VALIDATED.MIN_HOLDERS}`);
  if (row.liq_usd_proxy < FRESH_VALIDATED.MIN_LIQ_USD_PROXY) reasons.push(`liq_proxy<${FRESH_VALIDATED.MIN_LIQ_USD_PROXY}`);
  const vol1m = row.buy_usd_1m + row.sell_usd_1m;
  if (FRESH_VALIDATED.MIN_VOL1M_USD > 0 && vol1m < FRESH_VALIDATED.MIN_VOL1M_USD) {
    reasons.push(`vol1m<${FRESH_VALIDATED.MIN_VOL1M_USD}`);
  }
  const vol = row.buy_usd_5m + row.sell_usd_5m;
  if (vol < FRESH_VALIDATED.MIN_VOL5M_USD) reasons.push(`vol5m<${FRESH_VALIDATED.MIN_VOL5M_USD}`);
  const bs = row.sell_usd_5m > 0 ? row.buy_usd_5m / row.sell_usd_5m : (row.buy_usd_5m > 0 ? Infinity : 0);
  if (bs < FRESH_VALIDATED.MIN_BS_5M) reasons.push(`bs5m<${FRESH_VALIDATED.MIN_BS_5M}`);
  if (row.top_buyer_share > FRESH_VALIDATED.MAX_TOP_SHARE) reasons.push(`top>${FRESH_VALIDATED.MAX_TOP_SHARE * 100}%`);
  if (FRESH_VALIDATED.REQUIRE_GROWTH) {
    if (row.growth_pct === null) reasons.push('no_early_baseline');
    else if (row.growth_pct < FRESH_VALIDATED.MIN_GROWTH_FROM_EARLY * 100) reasons.push(`growth<${FRESH_VALIDATED.MIN_GROWTH_FROM_EARLY * 100}%`);
  }
  if (row.has_scam) reasons.push('scam_holder_in_top');
  return { pass: reasons.length === 0, reasons };
}

// =====================================================================
// LOOPS
// =====================================================================
let stats = { discovered: 0, evaluated: 0, passed: 0, opened: 0, closed: { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0 } };

async function discoverySmartLottery(): Promise<void> {
  const rows = await fetchSmartLotteryCandidates();
  if (!rows.length) {
    heartbeatIfDue({ kind_detail: 'smart_lottery_no_candidates' });
    return;
  }
  stats.discovered += rows.length;

  for (const row of rows) {
    if (!shouldEvaluate(row.mint)) continue;
    stats.evaluated++;

    const v = evaluateSmartLottery(row);
    const features = {
      age_min: +Number(row.age_min || 0).toFixed(1),
      early_buyers: row.early_buyers,
      smart_buyers: row.smart_buyers,
      scam_hits: row.scam_hits,
      smart_tags: row.smart_tags,
      scam_tags: row.scam_tags,
      total_buy_usd: +Number(row.total_buy_usd || 0).toFixed(2),
    };
    append({
      kind: 'eval',
      lane: 'launchpad_early',
      strategy_kind: 'smart_lottery',
      mint: row.mint,
      symbol: row.symbol,
      ageMin: features.age_min,
      pass: v.pass,
      reasons: v.reasons,
      m: features,
      btc: btcCtx(),
    });
    if (!v.pass) continue;
    stats.passed++;
    if (DRY_RUN) continue;

    const cur = await fetchCurrentMc(row.mint);
    await sleep(120);
    if (!cur || cur.mc <= 0) {
      append({ kind: 'eval-skip-open', lane: 'launchpad_early', mint: row.mint, reason: 'no_mc' });
      continue;
    }
    const ot = makeOpenTradeFromEntry({
      mint: row.mint,
      symbol: row.symbol,
      lane: 'launchpad_early',
      source: 'pumpfun',
      metricType: 'mc',
      entryPrice: cur.mc,
      entryMetrics: { uniqueBuyers: row.early_buyers, uniqueSellers: 0, sumBuySol: 0, sumSellSol: 0, topBuyerShare: 0, bcProgress: 0 },
    });
    const ctxSwaps = await fetchContextSwaps(row.mint, ot.entryTs);
    const preDyn = await fetchPreEntryDynamics(row.mint, ot.entryTs);
    append({ kind: 'open', ...ot, features, btc: btcCtx(), context_swaps: ctxSwaps, pre_entry_dynamics: preDyn });
    open.set(row.mint, ot);
    stats.opened++;
    schedulePendingFollowups({ mint: ot.mint, symbol: ot.symbol, entryTs: ot.entryTs, entryPrice: ot.legs[0].price, entryMarketPrice: ot.legs[0].marketPrice, metricType: ot.metricType, source: ot.source });
    console.log(`[OPEN][smart_lottery] ${row.mint.slice(0, 8)} $${row.symbol} mc=$${(cur.mc / 1000).toFixed(1)}k smart=${row.smart_buyers} tags=${(row.smart_tags || []).join(',')}`);
  }
}

async function discoveryFreshValidated(): Promise<void> {
  const rows = await fetchFreshValidatedCandidates();
  if (!rows.length) {
    heartbeatIfDue({ kind_detail: 'fresh_validated_no_candidates' });
    return;
  }
  stats.discovered += rows.length;

  for (const row of rows) {
    if (!shouldEvaluate(row.mint)) continue;
    stats.evaluated++;

    const v = evaluateFreshValidated(row);
    const features = {
      age_min: +Number(row.age_min || 0).toFixed(1),
      holders: row.holders,
      growth_pct: row.growth_pct !== null ? +row.growth_pct.toFixed(2) : null,
      buy_usd_1m: +Number(row.buy_usd_1m || 0).toFixed(2),
      sell_usd_1m: +Number(row.sell_usd_1m || 0).toFixed(2),
      buy_usd_5m: +Number(row.buy_usd_5m || 0).toFixed(2),
      sell_usd_5m: +Number(row.sell_usd_5m || 0).toFixed(2),
      bs_5m: row.sell_usd_5m > 0 ? +(row.buy_usd_5m / row.sell_usd_5m).toFixed(2) : null,
      top_share: +Number(row.top_buyer_share || 0).toFixed(3),
      total_buy_usd: +Number(row.total_buy_usd || 0).toFixed(2),
      liq_usd_proxy: +Number(row.liq_usd_proxy || 0).toFixed(2),
      has_scam: row.has_scam,
      scam_tags: row.scam_tags,
    };
    append({
      kind: 'eval',
      lane: 'launchpad_early',
      strategy_kind: 'fresh_validated',
      mint: row.mint,
      symbol: row.symbol,
      ageMin: features.age_min,
      pass: v.pass,
      reasons: v.reasons,
      m: features,
      btc: btcCtx(),
    });
    if (!v.pass) continue;
    stats.passed++;
    if (DRY_RUN) continue;

    const cur = await fetchCurrentMc(row.mint);
    await sleep(120);
    if (!cur || cur.mc <= 0) {
      append({ kind: 'eval-skip-open', lane: 'launchpad_early', mint: row.mint, reason: 'no_mc' });
      continue;
    }
    if (FRESH_VALIDATED.MIN_ENTRY_MC_USD > 0 && cur.mc < FRESH_VALIDATED.MIN_ENTRY_MC_USD) {
      append({
        kind: 'eval',
        lane: 'launchpad_early',
        strategy_kind: 'fresh_validated',
        mint: row.mint,
        symbol: row.symbol,
        pass: false,
        reasons: [`mc_usd<${FRESH_VALIDATED.MIN_ENTRY_MC_USD}`],
        m: { ...features, entry_mc_usd: +cur.mc.toFixed(0) },
        btc: btcCtx(),
      });
      continue;
    }

    let freshWhale: WhaleAnalysis | null = null;
    if (process.env.PAPER_FV_WHALE_ANALYSIS_ENABLED === '1') {
      freshWhale = await fetchWhaleAnalysis(row.mint);
      const wReasons = rejectReasonsForFreshWhale(freshWhale);
      if (wReasons.length) {
        append({
          kind: 'eval',
          lane: 'launchpad_early',
          strategy_kind: 'fresh_validated',
          mint: row.mint,
          symbol: row.symbol,
          pass: false,
          reasons: wReasons,
          m: { ...features, entry_mc_usd: +cur.mc.toFixed(0) },
          whale_analysis: freshWhale,
          btc: btcCtx(),
        });
        continue;
      }
    }

    const ot = makeOpenTradeFromEntry({
      mint: row.mint,
      symbol: row.symbol,
      lane: 'launchpad_early',
      source: FRESH_VALIDATED.TRADE_SOURCE,
      metricType: 'mc',
      entryPrice: cur.mc,
      entryMetrics: { uniqueBuyers: row.holders, uniqueSellers: 0, sumBuySol: 0, sumSellSol: 0, topBuyerShare: row.top_buyer_share, bcProgress: 0 },
    });
    const ctxSwaps = await fetchContextSwaps(row.mint, ot.entryTs);
    const preDyn = await fetchPreEntryDynamics(row.mint, ot.entryTs);
    const openExtra =
      process.env.PAPER_FV_WHALE_ANALYSIS_ENABLED === '1' && freshWhale
        ? { whale_analysis: freshWhale }
        : {};
    append({ kind: 'open', ...ot, features, btc: btcCtx(), context_swaps: ctxSwaps, pre_entry_dynamics: preDyn, ...openExtra });
    open.set(row.mint, ot);
    stats.opened++;
    schedulePendingFollowups({ mint: ot.mint, symbol: ot.symbol, entryTs: ot.entryTs, entryPrice: ot.legs[0].price, entryMarketPrice: ot.legs[0].marketPrice, metricType: ot.metricType, source: ot.source });
    console.log(`[OPEN][fresh_validated] ${row.mint.slice(0, 8)} $${row.symbol} mc=$${(cur.mc / 1000).toFixed(1)}k holders=${row.holders} growth=${features.growth_pct}%`);
  }
}

/**
 * Lane 2 для FV: «validated runners» из снапшотов raydium/meteora/pumpswap.
 * Пользуется DexScreener-данными (бесплатно), кредиты QuickNode не тратит.
 */
function evaluateFreshValidatedPostMig(row: SnapshotCandidateRow): { pass: boolean; reasons: string[] } {
  const cfg = FRESH_VALIDATED_POSTMIG;
  const reasons: string[] = [];
  const ageMin = Number(row.token_age_min ?? 0);
  if (ageMin < cfg.MIN_AGE_MIN) reasons.push(`age<${cfg.MIN_AGE_MIN}m`);
  if (cfg.MAX_AGE_MIN > 0 && ageMin > cfg.MAX_AGE_MIN) reasons.push(`age>${cfg.MAX_AGE_MIN}m`);
  if (Number(row.liquidity_usd ?? 0) < cfg.MIN_LIQ_USD) reasons.push(`liq<${cfg.MIN_LIQ_USD}`);
  if (Number(row.volume_5m ?? 0) < cfg.MIN_VOL5M_USD) reasons.push(`vol5m<${cfg.MIN_VOL5M_USD}`);
  if (Number(row.buys_5m ?? 0) < cfg.MIN_BUYS_5M) reasons.push(`buys5m<${cfg.MIN_BUYS_5M}`);
  const bs = Number(row.sells_5m ?? 0) > 0
    ? Number(row.buys_5m ?? 0) / Number(row.sells_5m ?? 0)
    : Number(row.buys_5m ?? 0);
  if (bs < cfg.MIN_BS) reasons.push(`bs<${cfg.MIN_BS.toFixed(2)}`);
  const mc = Number(row.market_cap_usd ?? 0);
  if (mc < cfg.MIN_MC_USD) reasons.push(`mc<${cfg.MIN_MC_USD}`);
  if (cfg.MAX_MC_USD > 0 && mc > cfg.MAX_MC_USD) reasons.push(`mc>${cfg.MAX_MC_USD}`);
  return { pass: reasons.length === 0, reasons };
}

async function discoveryFreshValidatedPostMig(): Promise<void> {
  if (!FRESH_VALIDATED_POSTMIG.ENABLED) return;
  const [migRows, postRows] = await Promise.all([
    fetchSnapshotLaneCandidates('migration_event').catch(() => [] as SnapshotCandidateRow[]),
    fetchSnapshotLaneCandidates('post_migration').catch(() => [] as SnapshotCandidateRow[]),
  ]);
  const rows = [...migRows, ...postRows];
  if (!rows.length) {
    heartbeatIfDue({ kind_detail: 'fresh_validated_postmig_no_candidates' });
    return;
  }
  stats.discovered += rows.length;

  for (const row of rows) {
    if (!shouldEvaluate(row.mint)) continue;
    stats.evaluated++;

    const v = evaluateFreshValidatedPostMig(row);
    const features = {
      age_min: +Number(row.token_age_min ?? 0).toFixed(1),
      liq_usd: +Number(row.liquidity_usd ?? 0).toFixed(0),
      vol5m_usd: +Number(row.volume_5m ?? 0).toFixed(0),
      buys_5m: Number(row.buys_5m ?? 0),
      sells_5m: Number(row.sells_5m ?? 0),
      bs: Number(row.sells_5m ?? 0) > 0
        ? +(Number(row.buys_5m ?? 0) / Number(row.sells_5m ?? 0)).toFixed(2)
        : null,
      mc_usd: +Number(row.market_cap_usd ?? 0).toFixed(0),
      price_usd: Number(row.price_usd ?? 0),
      source: row.source,
      holders: row.holder_count,
    };
    append({
      kind: 'eval',
      lane: 'post_migration',
      strategy_kind: 'fresh_validated',
      mint: row.mint,
      symbol: row.symbol,
      ageMin: features.age_min,
      pass: v.pass,
      reasons: v.reasons,
      m: features,
      btc: btcCtx(),
    });
    if (!v.pass) continue;
    stats.passed++;
    if (DRY_RUN) continue;

    const entryPrice = Number(row.market_cap_usd ?? row.price_usd ?? 0);
    if (entryPrice <= 0) {
      append({ kind: 'eval-skip-open', lane: 'post_migration', mint: row.mint, reason: 'no_entry_price' });
      continue;
    }
    const ot = makeOpenTradeFromEntry({
      mint: row.mint,
      symbol: row.symbol,
      lane: 'post_migration',
      source: row.source,
      metricType: row.market_cap_usd ? 'mc' : 'price',
      entryPrice,
      entryMetrics: {
        uniqueBuyers: Number(row.buys_5m ?? 0),
        uniqueSellers: Number(row.sells_5m ?? 0),
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
    });
    const ctxSwaps = await fetchContextSwaps(row.mint, ot.entryTs);
    const preDyn = await fetchPreEntryDynamics(row.mint, ot.entryTs);
    append({ kind: 'open', ...ot, features, btc: btcCtx(), context_swaps: ctxSwaps, pre_entry_dynamics: preDyn });
    open.set(row.mint, ot);
    stats.opened++;
    schedulePendingFollowups({ mint: ot.mint, symbol: ot.symbol, entryTs: ot.entryTs, entryPrice: ot.legs[0].price, entryMarketPrice: ot.legs[0].marketPrice, metricType: ot.metricType, source: ot.source });
    console.log(`[OPEN][fresh_validated/postmig] ${row.mint.slice(0, 8)} $${row.symbol} mc=$${(entryPrice/1000).toFixed(1)}k liq=$${(features.liq_usd/1000).toFixed(1)}k vol5m=$${(features.vol5m_usd/1000).toFixed(1)}k bs=${features.bs}`);
  }
}

/**
 * Dno / Oscar: вход как у `kind=dip` (post/migration, красная свеча, whale, cooldown);
 * DCA/TP/SL/timeout — из env профиля (STRATEGY_KIND остаётся fresh_validated).
 */
async function discoveryDipEntryForClones(): Promise<void> {
  const [migRows, postRows] = await Promise.all([
    ENABLE_MIGRATION_LANE ? fetchSnapshotLaneCandidates('migration_event') : Promise.resolve([] as SnapshotCandidateRow[]),
    ENABLE_POST_LANE ? fetchSnapshotLaneCandidates('post_migration') : Promise.resolve([] as SnapshotCandidateRow[]),
  ]);
  const snapshotRows = [...migRows, ...postRows];
  const dipMap = await fetchDipContextMap(snapshotRows);
  if (snapshotRows.length === 0) {
    heartbeatIfDue({
      kind_detail: 'dip_fv_clone_no_snapshot_candidates',
      fv_label: FRESH_VALIDATED.STRATEGY_LABEL,
    });
    return;
  }
  stats.discovered += snapshotRows.length;

  for (const row of snapshotRows) {
    const lane: Lane = migRows.includes(row) ? 'migration_event' : 'post_migration';
    if (!shouldEvaluate(row.mint)) continue;
    stats.evaluated++;
    const v = evaluateSnapshot(row, lane);
    const globalReasons = globalGate(row.token_age_min, row.holder_count);
    const dipEval = evaluateDip(row, dipMap.get(row.mint));
    const baseReasons = [...v.reasons, ...globalReasons, ...dipEval.reasons];
    const baseDipPass = baseReasons.length === 0;

    let whale: WhaleAnalysis | null = null;
    const whaleReasons: string[] = [];
    if (baseDipPass && WHALE.ENABLED) {
      whale = await fetchWhaleAnalysis(row.mint);
      if (whale.creator_dump_block) whaleReasons.push(`creator_dumping_${(whale.creator_dumped_pct * 100).toFixed(0)}%`);
      if (whale.dca_aggressive_present) whaleReasons.push('dca_aggressive_seller');
      if (WHALE.REQUIRE_TRIGGER && !whale.trigger_fired && !whaleReasons.length) {
        whaleReasons.push('no_whale_trigger');
      }
    }

    const cooldownMin = whale?.trigger_fired === 'dca_predictable' ? DIP.COOLDOWN_MIN_SCALP : DIP.COOLDOWN_MIN_DEFAULT;
    const lastEntry = lastEntryTsByMint.get(row.mint) || 0;
    const minutesSinceLast = (Date.now() - lastEntry) / 60_000;
    const cooldownReasons: string[] = [];
    if (lastEntry > 0 && minutesSinceLast < cooldownMin) {
      cooldownReasons.push(`cooldown_active_${cooldownMin}m_left_${(cooldownMin - minutesSinceLast).toFixed(0)}m`);
    }

    const mergedReasons = [...baseReasons, ...whaleReasons, ...cooldownReasons];
    const pass = mergedReasons.length === 0;
    const snapshotFeatures = {
      price_usd: +Number(row.price_usd || 0).toFixed(8),
      liq_usd: +Number(row.liquidity_usd || 0).toFixed(0),
      vol5m_usd: +Number(row.volume_5m || 0).toFixed(0),
      buys5m: row.buys_5m,
      sells5m: row.sells_5m,
      buy_sell_ratio_5m: row.sells_5m > 0 ? +(row.buys_5m / row.sells_5m).toFixed(2) : null,
      holders: row.holder_count,
      token_age_min: +Number(row.token_age_min ?? 0).toFixed(1),
      dip_pct: dipEval.dipPct !== null ? +Number(dipEval.dipPct).toFixed(2) : null,
      impulse_pct: dipEval.impulsePct !== null ? +Number(dipEval.impulsePct).toFixed(2) : null,
      market_cap_usd: +Number(row.market_cap_usd ?? 0).toFixed(0),
    };
    append({
      kind: 'eval',
      lane,
      source: row.source,
      mint: row.mint,
      symbol: row.symbol,
      ageMin: +Number(row.age_min ?? 0).toFixed(1),
      pass,
      reasons: mergedReasons,
      m: snapshotFeatures,
      btc: btcCtx(),
      whale_analysis: whale,
      strategy_kind: 'fresh_validated',
      entry_mode: 'dip_snapshot',
      fv_label: FRESH_VALIDATED.STRATEGY_LABEL,
    });
    if (!pass) continue;
    stats.passed++;
    if (DRY_RUN) continue;
    if (!(row.price_usd > 0)) {
      append({ kind: 'eval-skip-open', lane, source: row.source, mint: row.mint, reason: 'no_price' });
      continue;
    }

    const ot = makeOpenTradeFromEntry({
      mint: row.mint,
      symbol: row.symbol,
      lane,
      source: row.source,
      metricType: 'price',
      entryPrice: row.price_usd,
      entryMetrics: {
        uniqueBuyers: row.buys_5m,
        uniqueSellers: row.sells_5m,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
    });
    const ctxSwaps = await fetchContextSwaps(row.mint, ot.entryTs);
    const preDyn = await fetchPreEntryDynamics(row.mint, ot.entryTs);
    append({
      kind: 'open',
      ...ot,
      features: snapshotFeatures,
      btc: btcCtx(),
      context_swaps: ctxSwaps,
      pre_entry_dynamics: preDyn,
      whale_analysis: whale,
      entry_mode: 'dip_snapshot',
      opened_at_iso: new Date(ot.entryTs).toISOString(),
      entry_mc_usd: snapshotFeatures.market_cap_usd || null,
    });
    open.set(row.mint, ot);
    stats.opened++;
    lastEntryTsByMint.set(row.mint, ot.entryTs);
    schedulePendingFollowups({
      mint: ot.mint,
      symbol: ot.symbol,
      entryTs: ot.entryTs,
      entryPrice: ot.legs[0].price,
      entryMarketPrice: ot.legs[0].marketPrice,
      metricType: ot.metricType,
      source: ot.source,
    });
    console.log(
      `[OPEN][dip_fv_clone][${FRESH_VALIDATED.STRATEGY_LABEL}] ${row.mint.slice(0, 8)} $${row.symbol} px=${row.price_usd.toFixed(8)} src=${row.source}`,
    );
  }
}

let lastHeartbeatTs = 0;
function heartbeatIfDue(detail: Record<string, any>) {
  const now = Date.now();
  if (now - lastHeartbeatTs < 60_000) return;
  lastHeartbeatTs = now;
  append({ kind: 'heartbeat', ts: now, ...detail });
}

async function discoveryTick(): Promise<void> {
  if (STRATEGY_KIND === 'smart_lottery') {
    await discoverySmartLottery();
    return;
  }
  if (STRATEGY_KIND === 'fresh_validated' && USE_DIP_ENTRY) {
    await discoveryDipEntryForClones();
    return;
  }
  if (STRATEGY_KIND === 'fresh_validated') {
    await discoveryFreshValidated();
    if (FRESH_VALIDATED_POSTMIG.ENABLED) await discoveryFreshValidatedPostMig();
    return;
  }
  const [launchRows, migRows, postRows] = await Promise.all([
    (ENABLE_LAUNCHPAD_LANE && STRATEGY_KIND === 'fresh') ? fetchFreshAggregates() : Promise.resolve([] as FreshAggRow[]),
    ENABLE_MIGRATION_LANE ? fetchSnapshotLaneCandidates('migration_event') : Promise.resolve([] as SnapshotCandidateRow[]),
    ENABLE_POST_LANE ? fetchSnapshotLaneCandidates('post_migration') : Promise.resolve([] as SnapshotCandidateRow[]),
  ]);
  const snapshotRows = [...migRows, ...postRows];
  const dipMap = STRATEGY_KIND === 'dip' ? await fetchDipContextMap(snapshotRows) : new Map<string, DipContext>();

  const discoveredNow = launchRows.length + migRows.length + postRows.length;
  if (discoveredNow === 0) {
    heartbeatIfDue({ kind_detail: 'fresh_or_dip_no_candidates', strategy_kind: STRATEGY_KIND });
    return;
  }
  stats.discovered += discoveredNow;

  for (const row of launchRows) {
    if (!shouldEvaluate(row.mint)) continue;
    stats.evaluated++;

    const ageMin = (Date.now() - new Date(row.first_seen_at).getTime()) / 60_000;
    const m = computeMetrics(row, SOL_USD);
    const v = evaluate(m);
    const globalReasons = globalGate(ageMin, row.holder_count);
    const mergedReasons = [...v.reasons, ...globalReasons];
    const pass = mergedReasons.length === 0;

    const launchFeatures = {
      buyers: m.uniqueBuyers,
      sellers: m.uniqueSellers,
      buy_sol: +m.sumBuySol.toFixed(2),
      sell_sol: +m.sumSellSol.toFixed(2),
      top: +m.topBuyerShare.toFixed(2),
      bc: +m.bcProgress.toFixed(2),
      holders: row.holder_count,
      token_age_min: +ageMin.toFixed(1),
    };
    append({
      kind: 'eval',
      lane: 'launchpad_early',
      mint: row.mint,
      symbol: row.symbol,
      ageMin: +ageMin.toFixed(1),
      pass,
      reasons: mergedReasons,
      m: launchFeatures,
      btc: btcCtx(),
    });
    if (!pass) continue;
    stats.passed++;

    if (DRY_RUN) continue;
    const cur = await fetchCurrentMc(row.mint);
    await sleep(120);
    if (!cur || cur.mc <= 0) {
      append({ kind: 'eval-skip-open', lane: 'launchpad_early', mint: row.mint, reason: 'no_mc' });
      continue;
    }
    const ot = makeOpenTradeFromEntry({
      mint: row.mint,
      symbol: row.symbol,
      lane: 'launchpad_early',
      source: 'pumpfun',
      metricType: 'mc',
      entryPrice: cur.mc,
      entryMetrics: m,
    });
    const ctxSwaps = await fetchContextSwaps(row.mint, ot.entryTs);
    const preDyn = await fetchPreEntryDynamics(row.mint, ot.entryTs);
    append({ kind: 'open', ...ot, features: launchFeatures, btc: btcCtx(), context_swaps: ctxSwaps, pre_entry_dynamics: preDyn });
    open.set(row.mint, ot);
    stats.opened++;
    schedulePendingFollowups({ mint: ot.mint, symbol: ot.symbol, entryTs: ot.entryTs, entryPrice: ot.legs[0].price, entryMarketPrice: ot.legs[0].marketPrice, metricType: ot.metricType, source: ot.source });
    console.log(`[OPEN][launchpad_early] ${row.mint.slice(0, 8)} $${row.symbol} mc=$${(cur.mc / 1000).toFixed(1)}k`);
  }

  for (const row of snapshotRows) {
    const lane: Lane = migRows.includes(row) ? 'migration_event' : 'post_migration';
    if (!shouldEvaluate(row.mint)) continue;
    stats.evaluated++;
    const v = evaluateSnapshot(row, lane);
    const globalReasons = globalGate(row.token_age_min, row.holder_count);
    const dipEval = STRATEGY_KIND === 'dip' ? evaluateDip(row, dipMap.get(row.mint)) : { reasons: [], dipPct: null, impulsePct: null };
    const baseReasons = [...v.reasons, ...globalReasons, ...dipEval.reasons];
    const baseDipPass = baseReasons.length === 0;

    // Whale analysis runs only when other dip filters already passed (heavy SQLs)
    let whale: WhaleAnalysis | null = null;
    const whaleReasons: string[] = [];
    if (baseDipPass && STRATEGY_KIND === 'dip' && WHALE.ENABLED) {
      whale = await fetchWhaleAnalysis(row.mint);
      if (whale.creator_dump_block) whaleReasons.push(`creator_dumping_${(whale.creator_dumped_pct * 100).toFixed(0)}%`);
      if (whale.dca_aggressive_present) whaleReasons.push('dca_aggressive_seller');
      if (WHALE.REQUIRE_TRIGGER && !whale.trigger_fired && !whaleReasons.length) whaleReasons.push('no_whale_trigger');
    }

    // Per-mint cooldown (avoid hammering one coin)
    const cooldownMin = whale?.trigger_fired === 'dca_predictable' ? DIP.COOLDOWN_MIN_SCALP : DIP.COOLDOWN_MIN_DEFAULT;
    const lastEntry = lastEntryTsByMint.get(row.mint) || 0;
    const minutesSinceLast = (Date.now() - lastEntry) / 60_000;
    const cooldownReasons: string[] = [];
    if (lastEntry > 0 && minutesSinceLast < cooldownMin) {
      cooldownReasons.push(`cooldown_active_${cooldownMin}m_left_${(cooldownMin - minutesSinceLast).toFixed(0)}m`);
    }

    const mergedReasons = [...baseReasons, ...whaleReasons, ...cooldownReasons];
    const pass = mergedReasons.length === 0;
    const snapshotFeatures = {
      price_usd: +Number(row.price_usd || 0).toFixed(8),
      liq_usd: +Number(row.liquidity_usd || 0).toFixed(0),
      vol5m_usd: +Number(row.volume_5m || 0).toFixed(0),
      buys5m: row.buys_5m,
      sells5m: row.sells_5m,
      buy_sell_ratio_5m: row.sells_5m > 0 ? +(row.buys_5m / row.sells_5m).toFixed(2) : null,
      holders: row.holder_count,
      token_age_min: +Number(row.token_age_min ?? 0).toFixed(1),
      dip_pct: dipEval.dipPct !== null ? +Number(dipEval.dipPct).toFixed(2) : null,
      impulse_pct: dipEval.impulsePct !== null ? +Number(dipEval.impulsePct).toFixed(2) : null,
    };
    append({
      kind: 'eval',
      lane,
      source: row.source,
      mint: row.mint,
      symbol: row.symbol,
      ageMin: +Number(row.age_min ?? 0).toFixed(1),
      pass,
      reasons: mergedReasons,
      m: snapshotFeatures,
      btc: btcCtx(),
      whale_analysis: whale,
    });
    if (!pass) continue;
    stats.passed++;
    if (DRY_RUN) continue;
    if (!(row.price_usd > 0)) {
      append({ kind: 'eval-skip-open', lane, source: row.source, mint: row.mint, reason: 'no_price' });
      continue;
    }

    const ot = makeOpenTradeFromEntry({
      mint: row.mint,
      symbol: row.symbol,
      lane,
      source: row.source,
      metricType: 'price',
      entryPrice: row.price_usd,
      entryMetrics: {
        uniqueBuyers: row.buys_5m,
        uniqueSellers: row.sells_5m,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
    });
    const ctxSwaps = await fetchContextSwaps(row.mint, ot.entryTs);
    const preDyn = await fetchPreEntryDynamics(row.mint, ot.entryTs);
    append({
      kind: 'open',
      ...ot,
      features: snapshotFeatures,
      btc: btcCtx(),
      context_swaps: ctxSwaps,
      pre_entry_dynamics: preDyn,
      opened_at_iso: new Date(ot.entryTs).toISOString(),
      entry_mc_usd: snapshotFeatures.market_cap_usd || null,
    });
    open.set(row.mint, ot);
    stats.opened++;
    lastEntryTsByMint.set(row.mint, ot.entryTs);
    schedulePendingFollowups({ mint: ot.mint, symbol: ot.symbol, entryTs: ot.entryTs, entryPrice: ot.legs[0].price, entryMarketPrice: ot.legs[0].marketPrice, metricType: ot.metricType, source: ot.source });
    console.log(`[OPEN][${lane}] ${row.mint.slice(0, 8)} $${row.symbol} px=${row.price_usd.toFixed(8)} src=${row.source}`);
  }
}

function totalProceeds(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.proceedsUsd || 0), 0);
}

async function trackerTick(): Promise<void> {
  if (open.size === 0) return;
  const mints = [...open.keys()];
  for (const mint of mints) {
    const ot = open.get(mint);
    if (!ot) continue;
    rehydrateLegs(ot);

    let curMetric = 0;
    if (ot.metricType === 'mc') {
      const cur = await fetchCurrentMc(mint);
      curMetric = Number(cur?.mc ?? 0);
    } else {
      curMetric = Number(await fetchLatestSnapshotPrice(mint, ot.source) ?? 0);
    }
    await sleep(120);

    const ageH = (Date.now() - ot.entryTs) / 3_600_000;
    if (!(curMetric > 0)) {
      if (ageH > TIMEOUT_HOURS) {
        const grossPartials = ot.partialSells.reduce((s, p) => s + (p.grossProceedsUsd || 0), 0);
        const netPartials = totalProceeds(ot);
        const totalProceedsUsd = netPartials;
        const grossTotalProceedsUsd = grossPartials;
        const netPnlUsd = totalProceedsUsd - ot.totalInvestedUsd;
        const grossPnlUsd = grossTotalProceedsUsd - ot.totalInvestedUsd;
        const totalPnlPct = ot.totalInvestedUsd > 0 ? (netPnlUsd / ot.totalInvestedUsd) * 100 : -100;
        const grossPnlPct = ot.totalInvestedUsd > 0 ? (grossPnlUsd / ot.totalInvestedUsd) * 100 : -100;
        const ct: ClosedTrade = {
          ...ot,
          exitTs: Date.now(),
          exitMcUsd: 0,
          exitReason: 'NO_DATA',
          pnlPct: totalPnlPct,
          durationMin: ageH * 60,
          totalInvestedUsd: ot.totalInvestedUsd,
          totalProceedsUsd,
          netPnlUsd,
          grossTotalProceedsUsd,
          grossPnlUsd,
          grossPnlPct,
          costs: {
            fee_bps_per_side: FEE_BPS_PER_SIDE,
            slippage_bps_per_side: SLIPPAGE_BPS_PER_SIDE,
            cost_pct_per_side: COST_PCT_PER_SIDE,
          },
        };
        open.delete(mint); closed.push(ct); stats.closed.NO_DATA++;
        const exitSwaps = await fetchContextSwaps(mint, Date.now());
        append({ kind: 'close', ...ct, peak_pnl_pct: +ot.peakPnlPct.toFixed(2), btc_exit: btcCtx(), exit_swaps: exitSwaps });
        console.log(`[NO_DATA] ${mint.slice(0, 8)} $${ot.symbol}`);
      }
      continue;
    }

    // PnL relative to FIRST leg (used by DCA triggers) and to AVG entry (used by TP/SL/trailing)
    const firstPrice = ot.legs[0]?.price || ot.entryMcUsd;
    const dropFromFirstPct = ((curMetric / firstPrice) - 1);
    const xAvg = curMetric / ot.avgEntry;
    const pnlPctVsAvg = (xAvg - 1) * 100;

    // Update peak (vs avg entry)
    if (curMetric > ot.peakMcUsd) {
      const wasArmed = ot.trailingArmed;
      ot.peakMcUsd = curMetric;
      ot.peakPnlPct = pnlPctVsAvg;
      if (xAvg >= TRAIL_TRIGGER_X) ot.trailingArmed = true;
      // Пишем peak event при любом росте >= PAPER_PEAK_LOG_STEP_PCT (default 1%)
      // или при первом arming trail, чтобы рестарт восстанавливал актуальный пик из jsonl.
      const peakLogStepPct = Number(process.env.PAPER_PEAK_LOG_STEP_PCT ?? '1');
      const lastPersisted = (ot as any)._lastPersistedPeak ?? -Infinity;
      if ((!wasArmed && ot.trailingArmed) || pnlPctVsAvg >= lastPersisted + peakLogStepPct) {
        (ot as any)._lastPersistedPeak = pnlPctVsAvg;
        append({ kind: 'peak', mint, peakMcUsd: ot.peakMcUsd, peakPnlPct: ot.peakPnlPct, trailingArmed: ot.trailingArmed });
      }
    }

    // ============ DCA: добавление леджей при просадке от первого entry ============
    if (HAS_DCA && ot.remainingFraction > 0) {
      for (const lvl of DCA_LEVELS) {
        if (ot.dcaUsedLevels.has(lvl.triggerPct)) continue;
        if (dropFromFirstPct <= lvl.triggerPct) {
          const addUsd = POSITION_USD * lvl.addFraction;
          const marketBuy = curMetric;
          const effectiveBuy = effBuy(marketBuy);
          ot.legs.push({ ts: Date.now(), price: effectiveBuy, marketPrice: marketBuy, sizeUsd: addUsd, reason: 'dca', triggerPct: lvl.triggerPct });
          ot.totalInvestedUsd += addUsd;
          const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
          ot.avgEntry = num / ot.totalInvestedUsd;
          const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
          ot.avgEntryMarket = numM / ot.totalInvestedUsd;
          ot.dcaUsedLevels.add(lvl.triggerPct);
          ot.remainingFraction = 1; // we just added — full position is alive again until next partial-sell
          if (curMetric > ot.peakMcUsd) ot.peakMcUsd = curMetric;
          ot.peakPnlPct = ((curMetric / ot.avgEntry) - 1) * 100;
          ot.trailingArmed = ot.trailingArmed && (curMetric / ot.avgEntry) >= TRAIL_TRIGGER_X;
          append({
            kind: 'dca_add',
            mint,
            ts: Date.now(),
            price: effectiveBuy,
            marketPrice: marketBuy,
            sizeUsd: addUsd,
            triggerPct: lvl.triggerPct,
            avgEntry: ot.avgEntry,
            avgEntryMarket: ot.avgEntryMarket,
            totalInvestedUsd: ot.totalInvestedUsd,
            legCount: ot.legs.length,
          });
          console.log(`[DCA] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} @ trigger ${(lvl.triggerPct * 100).toFixed(0)}% avgEff=${ot.avgEntry.toFixed(8)} avgMkt=${ot.avgEntryMarket.toFixed(8)}`);
        }
      }
    }

    // ============ TP ladder: частичные продажи относительно avgEntry ============
    if (HAS_LADDER && ot.remainingFraction > 0) {
      for (const lvl of TP_LADDER) {
        if (ot.ladderUsedLevels.has(lvl.pnlPct)) continue;
        if (xAvg - 1 >= lvl.pnlPct) {
          const sellFraction = Math.min(1, lvl.sellFraction);
          const marketSell = curMetric;
          const effectiveSell = effSell(marketSell);
          // remaining position value (in USD) by EFFECTIVE prices = invested * remaining * (effSell / avgEffEntry)
          const remainingValueNet = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
          const proceedsUsd = remainingValueNet * sellFraction;
          // gross side: invested * remaining * (marketSell / avgMarketEntry)
          const remainingValueGross = ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
          const grossProceedsUsd = remainingValueGross * sellFraction;

          const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sellFraction;
          const pnlUsd = proceedsUsd - investedSoldUsd;
          const grossPnlUsd = grossProceedsUsd - investedSoldUsd;

          ot.partialSells.push({
            ts: Date.now(),
            price: effectiveSell,
            marketPrice: marketSell,
            sellFraction,
            reason: 'TP_LADDER',
            proceedsUsd,
            grossProceedsUsd,
            pnlUsd,
            grossPnlUsd,
          });
          ot.remainingFraction = ot.remainingFraction * (1 - sellFraction);
          ot.ladderUsedLevels.add(lvl.pnlPct);
          append({
            kind: 'partial_sell',
            mint,
            ts: Date.now(),
            price: effectiveSell,
            marketPrice: marketSell,
            sellFraction,
            ladderPnlPct: lvl.pnlPct,
            reason: 'TP_LADDER',
            proceedsUsd,
            grossProceedsUsd,
            pnlUsd,
            grossPnlUsd,
            remainingFraction: ot.remainingFraction,
          });
          console.log(`[TP${(lvl.pnlPct * 100).toFixed(0)}] ${mint.slice(0, 8)} $${ot.symbol} sold=${(sellFraction * 100).toFixed(0)}% pnl=$${pnlUsd.toFixed(2)} gross=$${grossPnlUsd.toFixed(2)} remain=${(ot.remainingFraction * 100).toFixed(0)}%`);
        }
      }
    }

    // ============ Killstop / SL / TP / TRAIL / TIMEOUT — финальный close ============
    let exitReason: ClosedTrade['exitReason'] | null = null;
    if (HAS_DCA && DCA_KILLSTOP < 0 && pnlPctVsAvg / 100 <= DCA_KILLSTOP) exitReason = 'KILLSTOP';
    else if (xAvg >= TP_X) exitReason = 'TP';
    else if (SL_X > 0 && xAvg <= SL_X) exitReason = 'SL';
    else if (ot.trailingArmed && curMetric <= ot.peakMcUsd * (1 - TRAIL_DROP)) exitReason = 'TRAIL';
    else if (ageH >= TIMEOUT_HOURS) exitReason = 'TIMEOUT';

    // Если ladder уже всё продал — закрываем позицию как TP_LADDER_DONE
    if (!exitReason && ot.remainingFraction <= 1e-6) exitReason = 'TP';

    if (exitReason) {
      const marketSell = curMetric;
      const effectiveSell = effSell(marketSell);
      // финальная продажа остатка
      let finalProceeds = 0;
      let finalGrossProceeds = 0;
      if (ot.remainingFraction > 1e-6) {
        finalProceeds = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
        finalGrossProceeds = ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
      }
      const totalProceedsUsd = totalProceeds(ot) + finalProceeds;
      const grossTotalProceedsUsd = ot.partialSells.reduce((s, p) => s + (p.grossProceedsUsd || 0), 0) + finalGrossProceeds;
      const netPnlUsd = totalProceedsUsd - ot.totalInvestedUsd;
      const grossPnlUsd = grossTotalProceedsUsd - ot.totalInvestedUsd;
      const totalPnlPct = ot.totalInvestedUsd > 0 ? (netPnlUsd / ot.totalInvestedUsd) * 100 : 0;
      const grossPnlPct = ot.totalInvestedUsd > 0 ? (grossPnlUsd / ot.totalInvestedUsd) * 100 : 0;

      const exitSwaps = await fetchContextSwaps(mint, Date.now());

      const ct: ClosedTrade = {
        ...ot,
        exitTs: Date.now(),
        exitMcUsd: marketSell,
        exitReason: exitReason as ClosedTrade['exitReason'],
        pnlPct: totalPnlPct,
        durationMin: ageH * 60,
        totalInvestedUsd: ot.totalInvestedUsd,
        totalProceedsUsd,
        netPnlUsd,
        grossTotalProceedsUsd,
        grossPnlUsd,
        grossPnlPct,
        costs: {
          fee_bps_per_side: FEE_BPS_PER_SIDE,
          slippage_bps_per_side: SLIPPAGE_BPS_PER_SIDE,
          cost_pct_per_side: COST_PCT_PER_SIDE,
        },
      };
      open.delete(mint);
      closed.push(ct);
      const statKey: ExitReason = (exitReason === 'KILLSTOP' ? 'SL' : exitReason) as ExitReason;
      if (stats.closed[statKey] != null) stats.closed[statKey]++;
      append({
        kind: 'close',
        ...ct,
        peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
        btc_exit: btcCtx(),
        exit_market_price: marketSell,
        exit_effective_price: effectiveSell,
        exit_swaps: exitSwaps,
      });
      const arrow = totalPnlPct >= 0 ? '+' : '';
      console.log(`[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${arrow}${totalPnlPct.toFixed(1)}%/$${netPnlUsd.toFixed(2)} pnl_gross=${grossPnlPct >= 0 ? '+' : ''}${grossPnlPct.toFixed(1)}%/$${grossPnlUsd.toFixed(2)} legs=${ot.legs.length} sells=${ot.partialSells.length} age=${ageH.toFixed(1)}h`);
    }
  }
}

async function followupTick(): Promise<void> {
  if (!FOLLOWUP_ENABLED || !pendingFollowups.length) return;
  const now = Date.now();
  const due = pendingFollowups.filter((f) => f.dueTs <= now);
  if (!due.length) return;

  for (const f of due) {
    const idx = pendingFollowups.indexOf(f);
    if (idx >= 0) pendingFollowups.splice(idx, 1);
    const key = fkey(f.mint, f.entryTs, f.offsetMin);
    if (completedFollowupKeys.has(key)) continue;

    let curMetric = 0;
    try {
      if (f.metricType === 'mc') {
        const cur = await fetchCurrentMc(f.mint);
        curMetric = Number(cur?.mc ?? 0);
      } else {
        curMetric = Number(await fetchLatestSnapshotPrice(f.mint, f.source) ?? 0);
      }
    } catch (err) {
      console.warn(`followup fetch failed ${f.mint}@+${f.offsetMin}m: ${err}`);
    }
    await sleep(120);

    if (curMetric > 0 && f.entryMarketPrice > 0) {
      const pnlPctVsEntry = ((curMetric / f.entryMarketPrice) - 1) * 100;
      append({
        kind: 'followup_snapshot',
        mint: f.mint,
        symbol: f.symbol,
        entryTs: f.entryTs,
        offsetMin: f.offsetMin,
        actual_offset_min: +(((Date.now() - f.entryTs) / 60_000)).toFixed(2),
        marketPrice: curMetric,
        entryMarketPrice: f.entryMarketPrice,
        pnlPctVsEntry: +pnlPctVsEntry.toFixed(2),
      });
    } else {
      append({
        kind: 'followup_snapshot',
        mint: f.mint,
        symbol: f.symbol,
        entryTs: f.entryTs,
        offsetMin: f.offsetMin,
        marketPrice: 0,
        error: 'no_data',
      });
    }
    completedFollowupKeys.add(key);
  }
}

function statsTick(): void {
  const wins = closed.filter(c => c.pnlPct > 0).length;
  const winRate = closed.length > 0 ? wins / closed.length * 100 : 0;
  const avgPnl = closed.length > 0 ? closed.reduce((s, c) => s + c.pnlPct, 0) / closed.length : 0;
  const sumPnl = closed.reduce((s, c) => s + c.pnlPct, 0);
  const peakAvg = closed.length > 0 ? closed.reduce((s, c) => s + c.peakPnlPct, 0) / closed.length : 0;
  console.log(`\n${'='.repeat(76)}`);
  console.log(`[STATS] discovered=${stats.discovered}  evaluated=${stats.evaluated}  passed=${stats.passed}  opened=${stats.opened}  sol=$${SOL_USD.toFixed(0)}`);
  console.log(`        open=${open.size}  closed=${closed.length}  wins=${wins}  win_rate=${winRate.toFixed(0)}%`);
  console.log(`        avg_pnl=${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%  sum_pnl=${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(1)}%  avg_peak=+${peakAvg.toFixed(1)}%`);
  console.log(`        exits: TP=${stats.closed.TP} SL=${stats.closed.SL} TRAIL=${stats.closed.TRAIL} TIMEOUT=${stats.closed.TIMEOUT} NO_DATA=${stats.closed.NO_DATA}`);
  console.log('='.repeat(76) + '\n');
}

// =====================================================================
// MAIN
// =====================================================================
async function main(): Promise<void> {
  console.log(`=== LIVE PAPER-TRADER (DB-only) ===`);
  console.log(`strategy=${STRATEGY_ID} kind=${STRATEGY_KIND} store=${STORE_PATH} dry_run=${DRY_RUN}`);
  console.log(`lanes: launchpad_early=${ENABLE_LAUNCHPAD_LANE} migration_event=${ENABLE_MIGRATION_LANE} post_migration=${ENABLE_POST_LANE}`);
  console.log(`global gates: token_age>=${GLOBAL_MIN_TOKEN_AGE_MIN}m holders>=${GLOBAL_MIN_HOLDER_COUNT}`);
  console.log(`filters: buyers≥${FILTERS.MIN_UNIQUE_BUYERS}, buy_sol≥${FILTERS.MIN_BUY_SOL}, top≤${FILTERS.MAX_TOP_BUYER_SHARE * 100}%, bc∈[${FILTERS.MIN_BC_PROGRESS * 100}..${FILTERS.MAX_BC_PROGRESS * 100}]%`);
  console.log(`window: [${WINDOW_START_MIN}..${DECISION_AGE_MIN}] min  exit: TP=${TP_X}x SL=${SL_X}x TRAIL=-${TRAIL_DROP * 100}% from peak (after ${TRAIL_TRIGGER_X}x)  TIMEOUT=${TIMEOUT_HOURS}h`);
  if (STRATEGY_KIND === 'dip' || (STRATEGY_KIND === 'fresh_validated' && USE_DIP_ENTRY)) {
    console.log(
      `dip gate: lookback=${DIP.LOOKBACK_MIN}m drop=[${DIP.MAX_DROP_PCT}%..${DIP.MIN_DROP_PCT}%] min_impulse=${DIP.MIN_IMPULSE_PCT}% min_age=${DIP.MIN_AGE_MIN}m`,
    );
  }
  if (STRATEGY_KIND === 'fresh_validated' && USE_DIP_ENTRY) {
    console.log(
      `entry: Deep Runner (post/mig snapshot + dip + whale)  fv_label=${FRESH_VALIDATED.STRATEGY_LABEL}  exits from this profile (DCA/TP/SL)`,
    );
  }
  console.log(`costs per side: fee=${FEE_BPS_PER_SIDE}bps slippage=${SLIPPAGE_BPS_PER_SIDE}bps total=${(COST_PCT_PER_SIDE * 100).toFixed(2)}% (round-trip ~${(COST_PCT_PER_SIDE * 200).toFixed(1)}%)`);
  console.log(`dca: ${HAS_DCA ? `levels=${DCA_LEVELS.map(l => `${l.triggerPct * 100}%:${l.addFraction * 100}%`).join(', ')} killstop=${DCA_KILLSTOP * 100}%` : 'off'}`);
  console.log(`tp_ladder: ${HAS_LADDER ? TP_LADDER.map(l => `+${l.pnlPct * 100}%:${l.sellFraction * 100}%`).join(', ') : 'off'}`);
  console.log(`context_swaps: ${CONTEXT_SWAPS_ENABLED ? `on, last ${CONTEXT_SWAPS_LIMIT}` : 'off'}`);
  console.log(`followup_snapshots: ${FOLLOWUP_ENABLED ? `at +${FOLLOWUP_OFFSETS_MIN.join('m, +')}m` : 'off'}`);
  console.log(`discovery interval: ${DISCOVERY_INTERVAL_MS / 1000}s, tracker: ${TRACK_INTERVAL_MS / 1000}s`);
  if (STRATEGY_KIND === 'dip' || (STRATEGY_KIND === 'fresh_validated' && USE_DIP_ENTRY)) {
    console.log(`whale analysis: ${WHALE.ENABLED ? `on (require_trigger=${WHALE.REQUIRE_TRIGGER ? 'yes' : 'no'} large_sell≥$${WHALE.LARGE_SELL_USD} cap≥${WHALE.CAPITULATION_PCT * 100}% group≥$${WHALE.GROUP_SELL_USD}@${WHALE.GROUP_MIN_SELLERS}wallets)` : 'off'}`);
    console.log(`per-mint cooldown: default=${DIP.COOLDOWN_MIN_DEFAULT}m scalp=${DIP.COOLDOWN_MIN_SCALP}m`);
  }

  loadStore();
  await refreshSolPrice();
  await refreshBtcContext();
  console.log(`[init] SOL=$${SOL_USD.toFixed(2)}  BTC ret1h=${btcRet1hPct?.toFixed(2) ?? 'n/a'}%  ret4h=${btcRet4hPct?.toFixed(2) ?? 'n/a'}%`);

  // hard watchdog: if a tick hangs (DB stall, network freeze) — kill it and let next one run
  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
    ]);
  }

  let discoveryRunning = false;
  let discoveryStartedAt = 0;
  setInterval(async () => {
    if (discoveryRunning) {
      const stuckMs = Date.now() - discoveryStartedAt;
      if (stuckMs > 90_000) console.warn(`discovery stuck for ${(stuckMs / 1000).toFixed(0)}s, will be released by timeout`);
      return;
    }
    discoveryRunning = true;
    discoveryStartedAt = Date.now();
    try { await withTimeout(discoveryTick(), 60_000, 'discoveryTick'); }
    catch (err) { console.warn(`discovery err: ${err}`); }
    discoveryRunning = false;
  }, DISCOVERY_INTERVAL_MS);

  let trackerRunning = false;
  let trackerStartedAt = 0;
  setInterval(async () => {
    if (trackerRunning) {
      const stuckMs = Date.now() - trackerStartedAt;
      if (stuckMs > 60_000) console.warn(`tracker stuck for ${(stuckMs / 1000).toFixed(0)}s`);
      return;
    }
    trackerRunning = true;
    trackerStartedAt = Date.now();
    try { await withTimeout(trackerTick(), 45_000, 'trackerTick'); }
    catch (err) { console.warn(`tracker err: ${err}`); }
    trackerRunning = false;
  }, TRACK_INTERVAL_MS);

  setInterval(statsTick, STATS_INTERVAL_MS);
  setInterval(refreshSolPrice, SOL_PRICE_REFRESH_MS);
  setInterval(refreshBtcContext, 60_000);

  let followupRunning = false;
  setInterval(async () => {
    if (followupRunning) return;
    followupRunning = true;
    try { await followupTick(); } catch (err) { console.warn(`followup err: ${err}`); }
    followupRunning = false;
  }, FOLLOWUP_TICK_MS);

  await discoveryTick();
  statsTick();

  process.on('SIGINT', () => { console.log('\n[shutdown] final stats:'); statsTick(); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\n[shutdown] final stats:'); statsTick(); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
