/**
 * Forensics: why a mint is not being bought by paper:live heuristics.
 * Mirrors env + logic from `scripts-tmp/live-paper-trader.ts` (one source of truth for thresholds).
 *
 * Does NOT re-run whale SQL, re-eval TTL, or per-mint cooldown (see `notes` in output).
 *
 * Usage:
 *   npx tsx src/scripts/diagnose-mint-strategies.ts MINT [MINT2...]
 *   npx tsx src/scripts/diagnose-mint-strategies.ts MINT --json
 *   npx tsx src/scripts/diagnose-mint-strategies.ts --config   # print resolved thresholds
 *
 * Requires DATABASE_URL (see .env).
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';

// ----- env (keep in sync with live-paper-trader.ts) -----

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const ATLAS_SCAM_TAGS = (process.env.PAPER_SCAM_TAGS ||
  'scam_operator,scam_proxy,scam_treasury,scam_payout,bot_farm_distributor,bot_farm_boss,gas_distributor,terminal_distributor,insider')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ATLAS_SMART_TAGS = (process.env.PAPER_SMART_TAGS ||
  'smart_money,smart_trader,whale,sniper,meme_flipper,rotation_node')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SMART_LOTTERY = {
  WINDOW_MIN: Number(process.env.PAPER_SMART_WINDOW_MIN || 5),
  MIN_AGE_MIN: Number(process.env.PAPER_SMART_MIN_AGE_MIN || 1),
  MAX_AGE_MIN: Number(process.env.PAPER_SMART_MAX_AGE_MIN || 30),
  EARLY_LIMIT: Number(process.env.PAPER_SMART_EARLY_LIMIT || 30),
  MIN_AMOUNT_USD: Number(process.env.PAPER_SMART_MIN_AMOUNT_USD || 1),
};

const FRESH_VALIDATED = {
  MIN_AGE_MIN: envNum('PAPER_FV_MIN_AGE_MIN', 30),
  MAX_AGE_MIN: envNum('PAPER_FV_MAX_AGE_MIN', 120),
  MIN_HOLDERS: Number(process.env.PAPER_FV_MIN_HOLDERS || 150),
  MIN_LIQ_USD_PROXY: Number(process.env.PAPER_FV_MIN_LIQ_USD_PROXY || 8000),
  MIN_VOL5M_USD: Number(process.env.PAPER_FV_MIN_VOL5M_USD || 1500),
  MIN_VOL1M_USD: Number(process.env.PAPER_FV_MIN_VOL1M_USD || 0),
  MIN_BS_5M: Number(process.env.PAPER_FV_MIN_BS_5M || 1.3),
  MAX_TOP_SHARE: Number(process.env.PAPER_FV_MAX_TOP_SHARE || 0.25),
  MIN_GROWTH_FROM_EARLY: Number(process.env.PAPER_FV_MIN_GROWTH || 0.5),
  EARLY_WINDOW_FROM_MIN: Number(process.env.PAPER_FV_EARLY_FROM_MIN || 10),
  EARLY_WINDOW_TO_MIN: Number(process.env.PAPER_FV_EARLY_TO_MIN || 15),
  REQUIRE_LAUNCHPAD: process.env.PAPER_FV_REQUIRE_LAUNCHPAD !== '0',
  REQUIRE_GROWTH: Number(process.env.PAPER_FV_MIN_GROWTH || 0.5) > 0,
  MIN_ENTRY_MC_USD: envNum('PAPER_FV_MIN_ENTRY_MC_USD', 0),
};

const GLOBAL_MIN_TOKEN_AGE_MIN = Number(process.env.PAPER_MIN_TOKEN_AGE_MIN || 0);
const GLOBAL_MIN_HOLDER_COUNT = Number(process.env.PAPER_MIN_HOLDER_COUNT || 0);

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

const SNAPSHOT_MIN_BS = envNum('PAPER_POST_MIN_BS', 1.0);

const WINDOW_START_MIN = Number(process.env.PAPER_WINDOW_START_MIN || 2);
const DECISION_AGE_MIN = Number(process.env.PAPER_DECISION_AGE_MIN || 7);
const DECISION_AGE_MAX_MIN = Number(process.env.PAPER_DECISION_AGE_MAX_MIN || 12);

const DIP = {
  LOOKBACK_MIN: Number(process.env.PAPER_DIP_LOOKBACK_MIN || 60),
  MIN_DROP_PCT: Number(process.env.PAPER_DIP_MIN_DROP_PCT || -12),
  MAX_DROP_PCT: Number(process.env.PAPER_DIP_MAX_DROP_PCT || -45),
  MIN_IMPULSE_PCT: Number(process.env.PAPER_DIP_MIN_IMPULSE_PCT || 20),
  MIN_AGE_MIN: Number(process.env.PAPER_DIP_MIN_AGE_MIN || 25),
};

const PAPER_STRATEGY_KIND = (process.env.PAPER_STRATEGY_KIND || 'fresh') as string;
const USE_DIP_ENTRY = process.env.PAPER_FV_USE_DIP_ENTRY === '1';
const SNAPSHOT_STALE_MAX_MIN = 30; // hardcoded in live-paper fetchSnapshotLaneCandidates

const LAUNCHPAD_SOURCES = ['pumpportal', 'moonshot', 'bonk'] as const;

function qMint(m: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) throw new Error(`invalid base58 mint: ${m}`);
  return m.replace(/'/g, "''");
}

function rowsOf(r: unknown): Record<string, unknown>[] {
  if (Array.isArray(r)) return r as Record<string, unknown>[];
  const o = r as { rows?: Record<string, unknown>[] };
  return o.rows ?? [];
}

const tableCache = new Map<string, boolean>();
async function tableExists(name: string): Promise<boolean> {
  if (tableCache.has(name)) return tableCache.get(name)!;
  const r = await db.execute(dsql.raw(`SELECT to_regclass('public.${name.replace(/[^a-z0-9_]/gi, '')}') AS t`));
  const row = rowsOf(r)[0];
  const ok = Boolean(row?.t);
  tableCache.set(name, ok);
  return ok;
}

function globalGate(tokenAgeMin: number | null | undefined, holderCount: number | null | undefined): string[] {
  const reasons: string[] = [];
  const age = Number(tokenAgeMin ?? 0);
  if (GLOBAL_MIN_TOKEN_AGE_MIN > 0 && age < GLOBAL_MIN_TOKEN_AGE_MIN) {
    reasons.push(`token_age<${GLOBAL_MIN_TOKEN_AGE_MIN}m`);
  }
  if (GLOBAL_MIN_HOLDER_COUNT > 0 && Number(holderCount ?? 0) < GLOBAL_MIN_HOLDER_COUNT) {
    reasons.push(`holders<${GLOBAL_MIN_HOLDER_COUNT}`);
  }
  return reasons;
}

function computeMetrics(
  row: {
    unique_buyers: number;
    unique_sellers: number;
    buy_usd: number;
    sell_usd: number;
    top_buyer_usd: number;
  },
  solUsd: number,
) {
  const sumBuySol = row.buy_usd / solUsd;
  const sumSellSol = row.sell_usd / solUsd;
  const topBuyerShare = row.buy_usd > 0 ? row.top_buyer_usd / row.buy_usd : 0;
  const bcProgress = Math.max(0, Math.min(1, (sumBuySol - sumSellSol) / BC_GRADUATION_SOL));
  return { uniqueBuyers: row.unique_buyers, topBuyerShare, sumBuySol, sumSellSol, bcProgress };
}

function evalFreshMetrics(m: ReturnType<typeof computeMetrics>): { pass: boolean; reasons: string[] } {
  const r: string[] = [];
  if (m.uniqueBuyers < FILTERS.MIN_UNIQUE_BUYERS) r.push(`buyers<${FILTERS.MIN_UNIQUE_BUYERS}`);
  if (m.sumBuySol < FILTERS.MIN_BUY_SOL) r.push(`buy_sol<${FILTERS.MIN_BUY_SOL}`);
  if (m.sumSellSol > 0 && m.sumBuySol / m.sumSellSol < FILTERS.MIN_BUY_SELL_RATIO) r.push(`bs<${FILTERS.MIN_BUY_SELL_RATIO}`);
  if (m.topBuyerShare > FILTERS.MAX_TOP_BUYER_SHARE) r.push(`top>${FILTERS.MAX_TOP_BUYER_SHARE * 100}%`);
  if (m.bcProgress < FILTERS.MIN_BC_PROGRESS) r.push(`bc<${FILTERS.MIN_BC_PROGRESS * 100}%`);
  if (m.bcProgress > FILTERS.MAX_BC_PROGRESS) r.push(`bc>${FILTERS.MAX_BC_PROGRESS * 100}%`);
  return { pass: r.length === 0, reasons: r };
}

function evalSnapshot(
  row: {
    liquidity_usd: number;
    volume_5m: number;
    buys_5m: number;
    sells_5m: number;
  },
  lane: 'migration' | 'post',
): { pass: boolean; reasons: string[] } {
  const cfg = lane === 'migration' ? LANE_MIGRATION : LANE_POST;
  const reasons: string[] = [];
  if (row.liquidity_usd < cfg.MIN_LIQ_USD) reasons.push(`liq<${cfg.MIN_LIQ_USD}`);
  if (row.volume_5m < cfg.MIN_VOL_5M_USD) reasons.push(`vol5m<${cfg.MIN_VOL_5M_USD}`);
  if (row.buys_5m < cfg.MIN_BUYS_5M) reasons.push(`buys5m<${cfg.MIN_BUYS_5M}`);
  if (row.sells_5m < cfg.MIN_SELLS_5M) reasons.push(`sells5m<${cfg.MIN_SELLS_5M}`);
  const bs = row.sells_5m > 0 ? row.buys_5m / row.sells_5m : row.buys_5m;
  if (bs < SNAPSHOT_MIN_BS) reasons.push(`bs<${SNAPSHOT_MIN_BS}`);
  return { pass: reasons.length === 0, reasons };
}

function evalDip(
  priceUsd: number,
  highPx: number,
  lowPx: number,
  tokenAgeMin: number,
): { pass: boolean; reasons: string[]; dipPct: number | null; impulsePct: number | null } {
  const reasons: string[] = [];
  if (tokenAgeMin < DIP.MIN_AGE_MIN) reasons.push(`dip_age<${DIP.MIN_AGE_MIN}m`);
  if (!(highPx > 0)) return { pass: false, reasons: [...reasons, 'dip_ctx_missing'], dipPct: null, impulsePct: null };
  const dipPct = (priceUsd / highPx - 1) * 100;
  if (dipPct > DIP.MIN_DROP_PCT) reasons.push(`dip_not_deep_enough>${DIP.MIN_DROP_PCT}%`);
  if (dipPct < DIP.MAX_DROP_PCT) reasons.push(`dip_too_deep<${DIP.MAX_DROP_PCT}%`);
  const impulsePct = lowPx > 0 ? (highPx / lowPx - 1) * 100 : null;
  if ((impulsePct ?? 0) < DIP.MIN_IMPULSE_PCT) reasons.push(`impulse<${DIP.MIN_IMPULSE_PCT}%`);
  return { pass: reasons.length === 0, reasons, dipPct, impulsePct };
}

function evalFreshValidatedRow(row: {
  holders: number;
  liq_usd_proxy: number;
  buy_usd_1m: number;
  sell_usd_1m: number;
  buy_usd_5m: number;
  sell_usd_5m: number;
  top_buyer_share: number;
  growth_pct: number | null;
  has_scam: boolean;
}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (row.holders < FRESH_VALIDATED.MIN_HOLDERS) reasons.push(`holders<${FRESH_VALIDATED.MIN_HOLDERS}`);
  if (row.liq_usd_proxy < FRESH_VALIDATED.MIN_LIQ_USD_PROXY) {
    reasons.push(`liq_proxy<${FRESH_VALIDATED.MIN_LIQ_USD_PROXY}`);
  }
  const vol1m = row.buy_usd_1m + row.sell_usd_1m;
  if (FRESH_VALIDATED.MIN_VOL1M_USD > 0 && vol1m < FRESH_VALIDATED.MIN_VOL1M_USD) {
    reasons.push(`vol1m<${FRESH_VALIDATED.MIN_VOL1M_USD}`);
  }
  const vol = row.buy_usd_5m + row.sell_usd_5m;
  if (vol < FRESH_VALIDATED.MIN_VOL5M_USD) reasons.push(`vol5m<${FRESH_VALIDATED.MIN_VOL5M_USD}`);
  const bs = row.sell_usd_5m > 0 ? row.buy_usd_5m / row.sell_usd_5m : row.buy_usd_5m > 0 ? Infinity : 0;
  if (bs < FRESH_VALIDATED.MIN_BS_5M) reasons.push(`bs5m<${FRESH_VALIDATED.MIN_BS_5M}`);
  if (row.top_buyer_share > FRESH_VALIDATED.MAX_TOP_SHARE) {
    reasons.push(`top>${FRESH_VALIDATED.MAX_TOP_SHARE * 100}%`);
  }
  if (FRESH_VALIDATED.REQUIRE_GROWTH) {
    if (row.growth_pct === null) reasons.push('no_early_baseline');
    else if (row.growth_pct < FRESH_VALIDATED.MIN_GROWTH_FROM_EARLY * 100) {
      reasons.push(`growth<${FRESH_VALIDATED.MIN_GROWTH_FROM_EARLY * 100}%`);
    }
  }
  if (row.has_scam) reasons.push('scam_holder_in_top');
  return { pass: reasons.length === 0, reasons };
}

function evalSmartLottery(row: {
  smart_buyers: number;
  scam_hits: number;
  early_buyers: number;
}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (row.smart_buyers <= 0) reasons.push('no_smart_signal');
  if (row.scam_hits > 0) reasons.push('scam_hit_in_early');
  if (row.early_buyers < 5) reasons.push('too_few_early_buyers<5');
  return { pass: reasons.length === 0, reasons };
}

async function jupSol(): Promise<number> {
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
    if (!r.ok) return 100;
    const j = (await r.json()) as Record<string, { usdPrice?: number } | undefined>;
    const px = Number(j?.[SOL_MINT]?.usdPrice ?? 0);
    if (px > 20 && px < 5000) return px;
  } catch {
    /* */
  }
  return 100;
}

async function pumpMc(mint: string): Promise<{ ok: boolean; usd_market_cap: number | null; raw: unknown }> {
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
    if (!r.ok) return { ok: false, usd_market_cap: null, raw: null };
    const t = await r.text();
    if (!t) return { ok: true, usd_market_cap: null, raw: null };
    const j = JSON.parse(t) as { usd_market_cap?: number };
    return { ok: true, usd_market_cap: j.usd_market_cap != null ? Number(j.usd_market_cap) : null, raw: j };
  } catch {
    return { ok: false, usd_market_cap: null, raw: null };
  }
}

export async function diagnoseOneMint(mint: string) {
  const m = qMint(mint);
  const solUsd = await jupSol();
  const scamList = ATLAS_SCAM_TAGS.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const smartList = ATLAS_SMART_TAGS.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');

  const tr = await db.execute(dsql.raw(`
    SELECT mint, symbol, first_seen_at, metadata, metadata->>'source' AS src
    FROM tokens WHERE mint = '${m}'
  `));
  const tokenRow = rowsOf(tr)[0] as
    | {
        mint: string;
        symbol: string;
        first_seen_at: string | Date;
        metadata: unknown;
        src: string | null;
      }
    | undefined;

  const swapR = await db.execute(dsql.raw(`
    SELECT
      count(*)::int AS n,
      min(block_time) AS first_swap,
      max(block_time) AS last_swap
    FROM swaps WHERE base_mint = '${m}'
  `));
  const swapStats = rowsOf(swapR)[0] as { n: number; first_swap: Date | null; last_swap: Date | null } | undefined;

  let tokenAgeMin: number | null = null;
  if (tokenRow?.first_seen_at) {
    tokenAgeMin = (Date.now() - new Date(tokenRow.first_seen_at).getTime()) / 60_000;
  }

  const hasRay = await tableExists('raydium_pair_snapshots');
  const hasMet = await tableExists('meteora_pair_snapshots');

  const out: Record<string, unknown> = {
    mint,
    meta: {
      paper_strategy_kind: PAPER_STRATEGY_KIND,
      paper_fv_use_dip_entry: USE_DIP_ENTRY,
      note: 'paper:live runs a single PAPER_STRATEGY_KIND; this report evaluates all strategy paths for forensics',
    },
    token: tokenRow
      ? {
          found: true,
          symbol: tokenRow.symbol,
          first_seen_at: new Date(tokenRow.first_seen_at).toISOString(),
          age_min: tokenAgeMin != null ? +tokenAgeMin.toFixed(2) : null,
          source: tokenRow.src,
        }
      : { found: false },
    swaps_in_db: swapStats
      ? {
          count: Number(swapStats.n ?? 0),
          first_swap: swapStats.first_swap ? new Date(swapStats.first_swap).toISOString() : null,
          last_swap: swapStats.last_swap ? new Date(swapStats.last_swap).toISOString() : null,
        }
      : { count: 0 },
  };

  // ---- fresh (launchpad 7–12m + STRICT window swaps 2–7m) ----
  let freshBlock: Record<string, unknown> = { path: 'fresh', enabled: true };
  if (!tokenRow) {
    freshBlock = { ...freshBlock, eligible: false, reasons: ['no_token_row_in_tokens'] };
  } else {
    const src = tokenRow.src;
    const srcOk = src != null && LAUNCHPAD_SOURCES.includes(src as (typeof LAUNCHPAD_SOURCES)[number]);
    const fs = new Date(tokenRow.first_seen_at).getTime();
    const a = (Date.now() - fs) / 60_000;
    const inWin = a > DECISION_AGE_MIN && a < DECISION_AGE_MAX_MIN;
    if (!srcOk) {
      freshBlock = { ...freshBlock, eligible: false, reasons: [`source_not_launchpad: ${src ?? 'null'}`] };
    } else if (!inWin) {
      freshBlock = {
        ...freshBlock,
        eligible: false,
        reasons: [`age_not_in_${DECISION_AGE_MIN}_${DECISION_AGE_MAX_MIN}m_window`],
        age_min: +a.toFixed(2),
        need_age_between: `${DECISION_AGE_MIN}m..${DECISION_AGE_MAX_MIN}m`,
      };
    } else {
      const r = await db.execute(dsql.raw(`
        WITH f AS (SELECT mint, symbol, first_seen_at FROM tokens WHERE mint = '${m}'),
        swaps_in_window AS (
          SELECT s.base_mint, s.wallet, s.side, s.amount_usd
          FROM swaps s
          JOIN f ON s.base_mint = f.mint
          WHERE s.block_time >= f.first_seen_at + interval '${WINDOW_START_MIN} minutes'
            AND s.block_time <= f.first_seen_at + interval '${DECISION_AGE_MIN} minutes'
            AND s.amount_usd >= 5
        ),
        per_buyer AS (
          SELECT base_mint, wallet, SUM(amount_usd) AS w_usd
          FROM swaps_in_window WHERE side = 'buy'
          GROUP BY base_mint, wallet
        ),
        aggs AS (
          SELECT base_mint,
            COUNT(DISTINCT wallet) FILTER (WHERE side='buy') AS unique_buyers,
            COUNT(DISTINCT wallet) FILTER (WHERE side='sell') AS unique_sellers,
            COALESCE(SUM(amount_usd) FILTER (WHERE side='buy'), 0) AS buy_usd,
            COALESCE(SUM(amount_usd) FILTER (WHERE side='sell'), 0) AS sell_usd
          FROM swaps_in_window
          GROUP BY base_mint
        ),
        tops AS (
          SELECT base_mint, MAX(w_usd) AS top_buyer_usd FROM per_buyer GROUP BY base_mint
        )
        SELECT
          COALESCE(a.unique_buyers, 0)::int AS unique_buyers,
          COALESCE(a.unique_sellers, 0)::int AS unique_sellers,
          COALESCE(a.buy_usd, 0)::float AS buy_usd,
          COALESCE(a.sell_usd, 0)::float AS sell_usd,
          COALESCE(t.top_buyer_usd, 0)::float AS top_buyer_usd
        FROM aggs a
        LEFT JOIN tops t ON t.base_mint = a.base_mint
      `));
      const ar = rowsOf(r)[0] as
        | {
            unique_buyers: number;
            unique_sellers: number;
            buy_usd: number;
            sell_usd: number;
            top_buyer_usd: number;
          }
        | undefined;
      if (!ar) {
        freshBlock = { ...freshBlock, eligible: true, metrics: null, reasons: ['no_aggregates_row'] };
      } else {
        const metrics = computeMetrics(
          {
            unique_buyers: ar.unique_buyers,
            unique_sellers: ar.unique_sellers,
            buy_usd: ar.buy_usd,
            sell_usd: ar.sell_usd,
            top_buyer_usd: ar.top_buyer_usd,
          },
          solUsd,
        );
        const v = evalFreshMetrics(metrics);
        const gr = globalGate(a, 0);
        const merged = [...v.reasons, ...gr];
        freshBlock = {
          ...freshBlock,
          eligible: true,
          would_pass_filters: merged.length === 0,
          window_minutes: `${WINDOW_START_MIN}..${DECISION_AGE_MIN}m after first_seen`,
          metrics: { ...metrics, topBuyerShare: +metrics.topBuyerShare.toFixed(4) },
          reasons: merged,
          open_note: merged.length === 0 ? 'would still need pump usd_market_cap>0 to open' : null,
        };
      }
    }
  }
  out.fresh = freshBlock;

  // ---- fresh_validated (SQL clone with mint filter) ----
  const maxAgeF =
    FRESH_VALIDATED.MAX_AGE_MIN > 0
      ? `AND first_seen_at >= now() - interval '${FRESH_VALIDATED.MAX_AGE_MIN} minutes'`
      : '';
  const launchF = FRESH_VALIDATED.REQUIRE_LAUNCHPAD
    ? `AND metadata->>'source' IN ('pumpportal','moonshot','bonk')`
    : '';
  const fvQ = await db.execute(dsql.raw(`
    WITH fresh AS (
      SELECT mint, symbol, first_seen_at
      FROM tokens
      WHERE mint = '${m}'
        AND first_seen_at <= now() - interval '${FRESH_VALIDATED.MIN_AGE_MIN} minutes'
        ${maxAgeF}
        ${launchF}
    ),
    sw AS (
      SELECT s.base_mint AS mint, s.wallet, s.side, s.amount_usd, s.price_usd, s.block_time, f.first_seen_at
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
      SELECT mint, MAX(price_usd)::float AS price_now,
        COALESCE(SUM(amount_usd) FILTER (WHERE side='buy'), 0)::float AS buy_usd_5m,
        COALESCE(SUM(amount_usd) FILTER (WHERE side='sell'), 0)::float AS sell_usd_5m
      FROM sw WHERE block_time >= now() - interval '5 minutes' GROUP BY mint
    ),
    recent1m AS (
      SELECT mint,
        COALESCE(SUM(amount_usd) FILTER (WHERE side='buy'), 0)::float AS buy_usd_1m,
        COALESCE(SUM(amount_usd) FILTER (WHERE side='sell'), 0)::float AS sell_usd_1m
      FROM sw WHERE block_time >= now() - interval '1 minute' GROUP BY mint
    ),
    holders AS (
      SELECT mint, COUNT(DISTINCT wallet)::int AS holders FROM sw WHERE side = 'buy' GROUP BY mint
    ),
    per_buyer AS (SELECT mint, wallet, SUM(amount_usd) AS w_usd FROM sw WHERE side = 'buy' GROUP BY mint, wallet),
    top_share AS (
      SELECT mint, MAX(w_usd)::float AS top_buyer_usd, SUM(w_usd)::float AS total_buy_usd FROM per_buyer GROUP BY mint
    ),
    scam_check AS (
      SELECT pb.mint, BOOL_OR(ew.primary_tag IN (${scamList})) AS has_scam
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
      COALESCE(ts.total_buy_usd, 0)::float AS liq_usd_proxy,
      CASE WHEN COALESCE(ts.total_buy_usd, 0) > 0 THEN COALESCE(ts.top_buyer_usd, 0) / ts.total_buy_usd ELSE 0 END::float AS top_buyer_share,
      COALESCE(sc.has_scam, false) AS has_scam
    FROM fresh f
    LEFT JOIN holders h ON h.mint = f.mint
    LEFT JOIN early e ON e.mint = f.mint
    LEFT JOIN recent rc ON rc.mint = f.mint
    LEFT JOIN recent1m r1 ON r1.mint = f.mint
    LEFT JOIN top_share ts ON ts.mint = f.mint
    LEFT JOIN scam_check sc ON sc.mint = f.mint
  `));
  const fvRows = rowsOf(fvQ);
  let fvBlock: Record<string, unknown>;
  if (!fvRows.length) {
    fvBlock = {
      path: 'fresh_validated',
      in_sql_candidate_set: false,
      reasons: [
        'not_in_fv_window_or_failed_launchpad_gate',
        `min_age=${FRESH_VALIDATED.MIN_AGE_MIN}m max_age=${FRESH_VALIDATED.MAX_AGE_MIN || 'off'} require_launchpad=${FRESH_VALIDATED.REQUIRE_LAUNCHPAD}`,
      ],
    };
  } else {
    const fr = fvRows[0] as {
      price_at_early: number;
      price_now: number;
      [k: string]: unknown;
    };
    const g =
      fr.price_at_early > 0 ? ((Number(fr.price_now) / fr.price_at_early) - 1) * 100 : null;
    const row = { ...fr, growth_pct: g, has_scam: Boolean(fr.has_scam) } as unknown as Parameters<
      typeof evalFreshValidatedRow
    >[0];
    const v = evalFreshValidatedRow(row);
    fvBlock = { path: 'fresh_validated', in_sql_candidate_set: true, would_pass: v.pass, reasons: v.reasons, row: { ...fr, growth_pct: g } };
  }
  if (FRESH_VALIDATED.MIN_ENTRY_MC_USD > 0) {
    const pm = await pumpMc(mint);
    const mc = pm.usd_market_cap;
    const mcr = { required: FRESH_VALIDATED.MIN_ENTRY_MC_USD, have: mc };
    if (mc != null && mc < FRESH_VALIDATED.MIN_ENTRY_MC_USD) {
      fvBlock = {
        ...fvBlock,
        entry_mc_gate: 'fail',
        entry_mc: mcr,
        extra_reason: `mc_usd<${FRESH_VALIDATED.MIN_ENTRY_MC_USD}`,
      };
    } else {
      fvBlock = { ...fvBlock, entry_mc_gate: FRESH_VALIDATED.MIN_ENTRY_MC_USD > 0 ? 'ok_or_off' : 'off', entry_mc: mcr };
    }
  }
  out.fresh_validated = fvBlock;

  // ---- smart_lottery ----
  const slQ = await db.execute(dsql.raw(`
    WITH fresh AS (
      SELECT mint, symbol, first_seen_at
      FROM tokens
      WHERE mint = '${m}'
        AND first_seen_at <= now() - interval '${SMART_LOTTERY.MIN_AGE_MIN} minutes'
        AND first_seen_at >= now() - interval '${SMART_LOTTERY.MAX_AGE_MIN} minutes'
        AND metadata->>'source' IN ('pumpportal','moonshot','bonk')
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
    early_top AS (SELECT * FROM early WHERE rn <= ${SMART_LOTTERY.EARLY_LIMIT}),
    tagged AS (
      SELECT et.mint, et.wallet, et.amount_usd, ew.primary_tag
      FROM early_top et
      LEFT JOIN entity_wallets ew ON ew.wallet = et.wallet
    ),
    agg AS (
      SELECT mint,
        COUNT(*) AS early_buyers,
        COUNT(*) FILTER (WHERE primary_tag IN (${smartList})) AS smart_buyers,
        COUNT(*) FILTER (WHERE primary_tag IN (${scamList})) AS scam_hits
      FROM tagged
      GROUP BY mint
    )
    SELECT
      f.mint,
      COALESCE(a.early_buyers, 0)::int AS early_buyers,
      COALESCE(a.smart_buyers, 0)::int AS smart_buyers,
      COALESCE(a.scam_hits, 0)::int AS scam_hits
    FROM fresh f
    LEFT JOIN agg a ON a.mint = f.mint
  `));
  const slR = rowsOf(slQ)[0] as
    | { early_buyers: number; smart_buyers: number; scam_hits: number }
    | undefined;
  let slBlock: Record<string, unknown>;
  if (!slR) {
    slBlock = {
      path: 'smart_lottery',
      in_sql_candidate_set: false,
      reasons: [
        'not_in_age_or_launchpad_source_window',
        `age: ${SMART_LOTTERY.MIN_AGE_MIN}..${SMART_LOTTERY.MAX_AGE_MIN}m`,
      ],
    };
  } else {
    const v = evalSmartLottery({
      early_buyers: slR.early_buyers,
      smart_buyers: slR.smart_buyers,
      scam_hits: slR.scam_hits,
    });
    slBlock = { path: 'smart_lottery', in_sql_candidate_set: true, would_pass: v.pass, reasons: v.reasons, row: slR };
  }
  out.smart_lottery = slBlock;

  // ---- Raydium / Meteora snapshot lanes (incl. stale) ----
  const snap: Record<string, unknown> = { tables: { raydium: hasRay, meteora: hasMet } };
  type SnapRow = {
    mint: string;
    symbol: string;
    ts: Date;
    base_mint: string;
    age_min: number;
    token_age_min: number;
    price_usd: number;
    liquidity_usd: number;
    volume_5m: number;
    buys_5m: number;
    sells_5m: number;
    source: string;
    minutes_since_snapshot: number;
  };
  const byDex: { source: string; table: string; row: SnapRow | null; stale: boolean }[] = [];
  for (const t of [
    { source: 'raydium', table: 'raydium_pair_snapshots' },
    { source: 'meteora', table: 'meteora_pair_snapshots' },
  ]) {
    if (!(await tableExists(t.table))) {
      byDex.push({ source: t.source, table: t.table, row: null, stale: false });
      continue;
    }
    const rq = await db.execute(dsql.raw(`
      SELECT
        p.base_mint AS mint,
        COALESCE(tok.symbol, '?') AS symbol,
        p.ts,
        EXTRACT(EPOCH FROM (p.ts - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS age_min,
        EXTRACT(EPOCH FROM (now() - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
        COALESCE(p.price_usd, 0)::float AS price_usd,
        COALESCE(p.liquidity_usd, 0)::float AS liquidity_usd,
        COALESCE(p.volume_5m, 0)::float AS volume_5m,
        COALESCE(p.buys_5m, 0)::int AS buys_5m,
        COALESCE(p.sells_5m, 0)::int AS sells_5m,
        EXTRACT(EPOCH FROM (now() - p.ts)) / 60.0 AS minutes_since_snapshot,
        '${t.source}'::text AS source
      FROM ${t.table} p
      LEFT JOIN tokens tok ON tok.mint = p.base_mint
      WHERE p.base_mint = '${m}'
      ORDER BY p.ts DESC
      LIMIT 1
    `));
    const one = rowsOf(rq)[0] as SnapRow | undefined;
    if (!one) {
      byDex.push({ source: t.source, table: t.table, row: null, stale: false });
    } else {
      const stale = one.minutes_since_snapshot > SNAPSHOT_STALE_MAX_MIN;
      byDex.push({ source: t.source, table: t.table, row: one, stale });
    }
  }
  snap.bydex = byDex;
  const pick =
    byDex
      .filter((x) => x.row && !x.stale)
      .map((x) => x.row!)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0] ?? null;
  if (!pick) {
    snap.candidate_for_live = null;
    snap.why = byDex.some((b) => b.stale)
      ? `latest snapshot older than live uses (must be <=${SNAPSHOT_STALE_MAX_MIN}m) OR no row`
      : 'no_dex_row_for_mint (pump_swap / other venues not in Raydium/Meteora pair_snapshots)';
  } else {
    const p = pick as SnapRow;
    const migEval = evalSnapshot(
      { liquidity_usd: p.liquidity_usd, volume_5m: p.volume_5m, buys_5m: p.buys_5m, sells_5m: p.sells_5m },
      'migration',
    );
    const postEval = evalSnapshot(
      { liquidity_usd: p.liquidity_usd, volume_5m: p.volume_5m, buys_5m: p.buys_5m, sells_5m: p.sells_5m },
      'post',
    );
    const mwin = p.age_min >= LANE_MIGRATION.MIN_AGE_MIN && p.age_min <= LANE_MIGRATION.MAX_AGE_MIN;
    const pwin = p.age_min >= LANE_POST.MIN_AGE_MIN && p.age_min <= LANE_POST.MAX_AGE_MIN;
    snap.candidate_for_live = {
      source: p.source,
      price_usd: p.price_usd,
      ts: p.ts,
      would_pass_migration: migEval,
      would_pass_post: postEval,
      age_mins: { pair_vs_launch: +p.age_min.toFixed(2), token: +p.token_age_min.toFixed(2) },
    };
    snap.lane_time_windows = {
      migration: {
        in_window: mwin,
        need_min: LANE_MIGRATION.MIN_AGE_MIN,
        need_max: LANE_MIGRATION.MAX_AGE_MIN,
        age_min: p.age_min,
        pass_if_time_and_metrics: mwin && migEval.pass,
        reasons: [...(mwin ? [] : ['age_outside_migration_window']), ...migEval.reasons],
      },
      post: {
        in_window: pwin,
        need_min: LANE_POST.MIN_AGE_MIN,
        need_max: LANE_POST.MAX_AGE_MIN,
        age_min: p.age_min,
        pass_if_time_and_metrics: pwin && postEval.pass,
        reasons: [...(pwin ? [] : ['age_outside_post_window']), ...postEval.reasons],
      },
    };
  }

  // Dip preview (if non-stale snapshot) — no whale
  if (pick) {
    const p = pick as SnapRow;
    const highLowR = await db.execute(dsql.raw(`
      SELECT
        MAX(COALESCE(price_usd, 0))::float AS high_px,
        MIN(NULLIF(COALESCE(price_usd, 0), 0))::float AS low_px
      FROM ${pick.source === 'raydium' ? 'raydium_pair_snapshots' : 'meteora_pair_snapshots'}
      WHERE ts >= now() - interval '${DIP.LOOKBACK_MIN} minutes'
        AND base_mint = '${m}'
    `));
    const hlr = rowsOf(highLowR)[0] as { high_px: number; low_px: number } | undefined;
    if (hlr) {
      const de = evalDip(p.price_usd, hlr.high_px, hlr.low_px, p.token_age_min);
      snap.dip = { would_pass: de.pass, reasons: de.reasons, dipPct: de.dipPct, impulsePct: de.impulsePct };
    }
  } else {
    snap.dip = { skipped: true, reason: 'no_fresh_dex_snapshot' };
  }

  out.raydium_meteora_snapshot = snap;
  out.pump_api = await pumpMc(mint);
  out.notes = [
    'pump swap / jupiter-detected coins without Raydium+Meteora pair_snapshots never reach migration/post lanes in live',
    'whale_gates, shouldEvaluate TTL, and re-entry cooldown are not simulated here',
  ];
  return out;
}

function printConfig() {
  const c = {
    PAPER_STRATEGY_KIND: PAPER_STRATEGY_KIND,
    PAPER_FV_USE_DIP_ENTRY: USE_DIP_ENTRY,
    FRESH: {
      DECISION_AGE_MIN,
      DECISION_AGE_MAX_MIN,
      WINDOW_START_MIN,
      FILTERS,
    },
    FRESH_VALIDATED,
    SMART_LOTTERY,
    LANE_MIGRATION,
    LANE_POST,
    SNAPSHOT_STALE_MAX_MIN,
    SNAPSHOT_MIN_BS,
    ATLAS_SCAM_TAGS,
    ATLAS_SMART_TAGS,
    GLOBAL_MIN_TOKEN_AGE_MIN,
    GLOBAL_MIN_HOLDER_COUNT,
  };
  console.log(JSON.stringify(c, null, 2));
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.includes('--config')) {
    printConfig();
    process.exit(0);
  }
  const asJson = raw.includes('--json');
  const margs = raw.filter((a) => a !== '--json');
  if (margs.length === 0) {
    console.error('Usage: tsx src/scripts/diagnose-mint-strategies.ts MINT [MINT2] [--json]  |  --config');
    process.exit(1);
  }

  const all: Record<string, unknown>[] = [];
  for (const a of margs) {
    const rep = await diagnoseOneMint(a);
    if (asJson) {
      all.push(rep);
    } else {
      console.log('\n' + '='.repeat(60));
      console.log(JSON.stringify(rep, null, 2));
    }
  }
  if (asJson) {
    console.log(JSON.stringify(margs.length > 1 ? { mints: all } : all[0], null, 2));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
