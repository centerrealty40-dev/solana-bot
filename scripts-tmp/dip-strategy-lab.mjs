import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const DEFAULT_WALLET = '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4LkNX54nJeFf9HYZ8sY2';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

const cmd = process.argv[2] || 'all';
const wallet = process.env.DIP_WALLET || DEFAULT_WALLET;
const lookbackDays = Number(process.env.DIP_LOOKBACK_DAYS || 30);
const maxSignatures = Number(process.env.DIP_MAX_SIGNATURES || 2500);
const outPath = process.env.DIP_OUT_PATH || 'scripts-tmp/dip-results.json';
const rpcUrl = process.env.PUBLIC_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const solUsdFallback = Number(process.env.SOL_USD || 150);
const positionUsd = Number(process.env.DIP_POSITION_USD || 75);
const RUNNER_MIN_HOLDERS = Number(process.env.DIP_RUNNER_MIN_HOLDERS || 2000);
const RUNNER_MIN_AGE_HOURS = Number(process.env.DIP_RUNNER_MIN_AGE_HOURS || 6);
const RUNNER_MAX_AGE_HOURS = Number(process.env.DIP_RUNNER_MAX_AGE_HOURS || 240);
const RUNNER_MIN_LP_TO_FDV = Number(process.env.DIP_RUNNER_MIN_LP_TO_FDV || 0.05);
const RUNNER_MIN_VOLUME_1H_USD = Number(process.env.DIP_RUNNER_MIN_VOLUME_1H_USD || 8000);
const RUNNER_MIN_VOLUME_1M_USD = Number(process.env.DIP_RUNNER_MIN_VOLUME_1M_USD || 120);
const RUNNER_MIN_TRADES_1H = Number(process.env.DIP_RUNNER_MIN_TRADES_1H || 45);
const RUNNER_MIN_BUYS_1H = Number(process.env.DIP_RUNNER_MIN_BUYS_1H || 20);
const RUNNER_MIN_SELLS_1H = Number(process.env.DIP_RUNNER_MIN_SELLS_1H || 8);
const RUNNER_HONEYPOT_MIN_BUYS_1H = Number(process.env.DIP_RUNNER_HONEYPOT_MIN_BUYS_1H || 10);
const RUNNER_HONEYPOT_MIN_BUYS_6H = Number(process.env.DIP_RUNNER_HONEYPOT_MIN_BUYS_6H || 30);
const RUNNER_MIN_SELL_BUY_RATIO_6H = Number(process.env.DIP_RUNNER_MIN_SELL_BUY_RATIO_6H || 0.05);
const RUNNER_KNIFE_WINDOW_MIN = Number(process.env.DIP_RUNNER_KNIFE_WINDOW_MIN || 5);
const RUNNER_KNIFE_MAX_DROP_PCT = Number(process.env.DIP_RUNNER_KNIFE_MAX_DROP_PCT || -14);
const BTC_MINTS = String(process.env.DIP_BTC_MINTS || '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const BTC_HALT_1H_PCT = Number(process.env.DIP_BTC_HALT_1H_PCT || -2.0);
const BTC_HALT_4H_PCT = Number(process.env.DIP_BTC_HALT_4H_PCT || -4.0);
const REQUIRE_INTEL_FIELDS = !['0', 'false', 'False', 'FALSE'].includes(String(process.env.DIP_REQUIRE_INTEL_FIELDS || '1'));
const MAX_ENTRIES_PER_MINT_WINDOW = Number(process.env.DIP_MAX_ENTRIES_PER_MINT_WINDOW || 2);
const ENTRIES_PER_MINT_WINDOW_MIN = Number(process.env.DIP_ENTRIES_PER_MINT_WINDOW_MIN || 180);
const SCAM_PRIMARY_TAGS = new Set(
  String(process.env.DIP_SCAM_PRIMARY_TAGS || 'scam_operator,scam_proxy,scam_treasury,scam_payout,bot_farm_distributor,bot_farm_boss,gas_distributor')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required; keep it in .env or process env, not in code.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PROFILES = [
  {
    id: 'conservative',
    entry: { dipPct: -30, lookbackMin: 15, minLiquidityUsd: 25000, minVolumeUsd5m: 3000, minTrades5m: 12, requireRouteable: true, maxSlippageBps: 250, cooldownMin: 90 },
    dca: {
      enabled: false,
      levels: [],
      killStopPct: -0.11,
      requireAliveForAdd: false,
    },
    exit: {
      stopLossPct: -0.11,
      tpLadder: [{ pnlPct: 0.10, sellFraction: 0.30 }, { pnlPct: 0.20, sellFraction: 0.30 }, { pnlPct: 0.50, sellFraction: 0.25 }],
      trailActivateAfterTp: 2,
      trailDropPct: 0.10,
      timeoutMin: 70,
    },
    risk: { maxOpen: 2 },
    costs: { feeBps: 30, slippageBps: 180 },
  },
  {
    id: 'balanced',
    entry: { dipPct: -22, lookbackMin: 10, minLiquidityUsd: 12000, minVolumeUsd5m: 1500, minTrades5m: 8, requireRouteable: true, maxSlippageBps: 350, cooldownMin: 45 },
    dca: {
      enabled: true,
      levels: [{ triggerPct: -0.08, addFraction: 0.50 }, { triggerPct: -0.16, addFraction: 0.75 }],
      killStopPct: -0.24,
      requireAliveForAdd: true,
    },
    exit: {
      stopLossPct: -0.10,
      tpLadder: [{ pnlPct: 0.10, sellFraction: 0.30 }, { pnlPct: 0.20, sellFraction: 0.30 }, { pnlPct: 0.50, sellFraction: 0.25 }],
      trailActivateAfterTp: 2,
      trailDropPct: 0.12,
      timeoutMin: 100,
    },
    risk: { maxOpen: 3 },
    costs: { feeBps: 30, slippageBps: 250 },
  },
  {
    id: 'dno_safe',
    entry: { dipPct: -18, lookbackMin: 8, minLiquidityUsd: 10000, minVolumeUsd5m: 1200, minTrades5m: 8, requireRouteable: true, maxSlippageBps: 300, cooldownMin: 35 },
    dca: {
      enabled: true,
      levels: [{ triggerPct: -0.07, addFraction: 0.35 }],
      killStopPct: -0.14,
      requireAliveForAdd: true,
    },
    exit: {
      stopLossPct: -0.09,
      tpLadder: [{ pnlPct: 0.08, sellFraction: 0.35 }, { pnlPct: 0.16, sellFraction: 0.35 }, { pnlPct: 0.35, sellFraction: 0.20 }],
      trailActivateAfterTp: 1,
      trailDropPct: 0.10,
      timeoutMin: 35,
    },
    risk: { maxOpen: 2 },
    costs: { feeBps: 30, slippageBps: 220 },
  },
  {
    id: 'aggressive',
    entry: { dipPct: -16, lookbackMin: 7, minLiquidityUsd: 6000, minVolumeUsd5m: 700, minTrades5m: 5, requireRouteable: false, maxSlippageBps: 600, cooldownMin: 25 },
    dca: {
      enabled: true,
      levels: [{ triggerPct: -0.10, addFraction: 0.70 }, { triggerPct: -0.20, addFraction: 1.00 }],
      killStopPct: -0.30,
      requireAliveForAdd: true,
    },
    exit: {
      stopLossPct: -0.14,
      tpLadder: [{ pnlPct: 0.10, sellFraction: 0.30 }, { pnlPct: 0.20, sellFraction: 0.30 }, { pnlPct: 0.50, sellFraction: 0.25 }],
      trailActivateAfterTp: 1,
      trailDropPct: 0.16,
      timeoutMin: 170,
    },
    risk: { maxOpen: 5 },
    costs: { feeBps: 30, slippageBps: 400 },
  },
];

function log(level, msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, component: 'dip-strategy-lab', msg, ...meta }));
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function extractAddresses(data) {
  if (!data || typeof data !== 'object') return [];
  const set = new Set(JSON.stringify(data).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []);
  return [...set];
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function maxDrawdown(pnlsUsd) {
  let equity = 0;
  let peak = 0;
  let mdd = 0;
  for (const pnl of pnlsUsd) {
    equity += pnl;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity - peak);
  }
  return mdd;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_trades_raw (
      id bigserial PRIMARY KEY,
      wallet text NOT NULL,
      signature text NOT NULL,
      slot bigint,
      block_time timestamptz NOT NULL,
      mint text NOT NULL,
      side text NOT NULL CHECK (side IN ('buy', 'sell')),
      token_amount double precision,
      quote_mint text,
      quote_amount double precision,
      amount_usd double precision,
      price_usd double precision,
      source text NOT NULL DEFAULT 'rpc_wallet_backfill',
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT wallet_trades_raw_wallet_sig_mint_side_uq UNIQUE (wallet, signature, mint, side)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS wallet_trades_raw_wallet_time_idx ON wallet_trades_raw (wallet, block_time DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS wallet_trades_raw_mint_time_idx ON wallet_trades_raw (mint, block_time DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS wallet_trades_raw_side_idx ON wallet_trades_raw (side)');
}

async function rpc(method, params, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    if (r.status === 429 && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      continue;
    }
    const j = await r.json();
    if (!j.error) return j.result;
    if (attempt >= retries || !String(j.error.message || '').match(/rate|limit|too many/i)) {
      throw new Error(`${method}: ${j.error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  throw new Error(`${method}: retry budget exhausted`);
}

async function fetchSolUsd() {
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
    const j = await r.json();
    return num(j?.[SOL_MINT]?.usdPrice ?? j?.data?.[SOL_MINT]?.price, solUsdFallback);
  } catch {
    return solUsdFallback;
  }
}

function uiAmount(balance) {
  return num(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount, 0) || 0;
}

function tokenDeltas(tx, owner) {
  const byMint = new Map();
  for (const b of tx?.meta?.preTokenBalances || []) {
    if (b.owner !== owner) continue;
    const cur = byMint.get(b.mint) || { mint: b.mint, pre: 0, post: 0 };
    cur.pre += uiAmount(b);
    byMint.set(b.mint, cur);
  }
  for (const b of tx?.meta?.postTokenBalances || []) {
    if (b.owner !== owner) continue;
    const cur = byMint.get(b.mint) || { mint: b.mint, pre: 0, post: 0 };
    cur.post += uiAmount(b);
    byMint.set(b.mint, cur);
  }
  return [...byMint.values()].map((v) => ({ mint: v.mint, delta: v.post - v.pre })).filter((v) => Math.abs(v.delta) > 1e-12);
}

function nativeSolDelta(tx, owner) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey?.toString?.() || k.pubkey) === owner);
  if (idx < 0) return 0;
  const pre = num(tx?.meta?.preBalances?.[idx], 0);
  const post = num(tx?.meta?.postBalances?.[idx], 0);
  const fee = tx?.transaction?.message?.accountKeys?.[0]?.pubkey?.toString?.() === owner ? num(tx?.meta?.fee, 0) : 0;
  return (post - pre + fee) / 1e9;
}

function parseWalletTrades(signature, tx, owner, solUsd) {
  if (!tx?.blockTime || tx?.meta?.err) return [];
  const deltas = tokenDeltas(tx, owner);
  const quoteDeltas = deltas.filter((d) => QUOTE_MINTS.has(d.mint));
  const nativeDelta = nativeSolDelta(tx, owner);
  if (Math.abs(nativeDelta) > 1e-9) quoteDeltas.push({ mint: SOL_MINT, delta: nativeDelta });

  const quote = quoteDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null;
  const bases = deltas.filter((d) => !QUOTE_MINTS.has(d.mint));
  const rows = [];

  for (const base of bases) {
    if (!quote || Math.sign(base.delta) === Math.sign(quote.delta)) continue;
    const side = base.delta > 0 ? 'buy' : 'sell';
    const quoteAbs = Math.abs(quote.delta);
    const amountUsd = quote.mint === SOL_MINT ? quoteAbs * solUsd : quoteAbs;
    const tokenAmount = Math.abs(base.delta);
    rows.push({
      wallet: owner,
      signature,
      slot: tx.slot,
      blockTime: new Date(tx.blockTime * 1000),
      mint: base.mint,
      side,
      tokenAmount,
      quoteMint: quote.mint,
      quoteAmount: quoteAbs,
      amountUsd,
      priceUsd: tokenAmount > 0 ? amountUsd / tokenAmount : null,
      raw: {
        source: 'getTransaction',
        quote_delta: quote.delta,
        base_delta: base.delta,
        fee_lamports: tx?.meta?.fee ?? null,
      },
    });
  }
  return rows;
}

async function backfillWallet() {
  await ensureSchema();
  const solUsd = await fetchSolUsd();
  const cutoffSec = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  let before;
  let scanned = 0;
  let inserted = 0;

  while (scanned < maxSignatures) {
    const batch = await rpc('getSignaturesForAddress', [wallet, { limit: Math.min(1000, maxSignatures - scanned), before }]);
    if (!batch?.length) break;
    for (const sig of batch) {
      before = sig.signature;
      if (sig.blockTime && sig.blockTime < cutoffSec) {
        scanned = maxSignatures;
        break;
      }
      scanned++;
      const tx = await rpc('getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const rows = parseWalletTrades(sig.signature, tx, wallet, solUsd);
      for (const row of rows) {
        const res = await pool.query(
          `INSERT INTO wallet_trades_raw (
             wallet, signature, slot, block_time, mint, side, token_amount, quote_mint,
             quote_amount, amount_usd, price_usd, raw
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (wallet, signature, mint, side) DO NOTHING`,
          [row.wallet, row.signature, row.slot, row.blockTime, row.mint, row.side, row.tokenAmount, row.quoteMint, row.quoteAmount, row.amountUsd, row.priceUsd, row.raw],
        );
        inserted += res.rowCount;
      }
      if (scanned % 50 === 0) log('info', 'wallet backfill progress', { wallet, scanned, inserted });
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.DIP_RPC_DELAY_MS || 160)));
    }
    if (batch.length < 1000) break;
  }
  return { wallet, lookback_days: lookbackDays, signatures_scanned: scanned, inserted_rows: inserted, sol_usd_used: solUsd };
}

async function loadWalletTrades() {
  const { rows } = await pool.query(
    `SELECT *
     FROM wallet_trades_raw
     WHERE wallet=$1 AND block_time >= now() - ($2::int * interval '1 day')
     ORDER BY block_time ASC`,
    [wallet, lookbackDays],
  );
  return rows;
}

async function priceBeforePct(mint, ts, minutes) {
  const { rows } = await pool.query(
    `WITH p AS (
       SELECT
         (SELECT price_usd FROM swaps WHERE base_mint=$1 AND block_time <= $2::timestamptz - ($3::int * interval '1 minute') AND price_usd > 0 ORDER BY block_time DESC LIMIT 1) AS before_px,
         (SELECT price_usd FROM swaps WHERE base_mint=$1 AND block_time <= $2::timestamptz AND price_usd > 0 ORDER BY block_time DESC LIMIT 1) AS entry_px
     )
     SELECT CASE WHEN before_px > 0 AND entry_px > 0 THEN (entry_px / before_px - 1) * 100 END AS pct
     FROM p`,
    [mint, ts, minutes],
  );
  return num(rows[0]?.pct);
}

function buildClosedPositions(trades) {
  const lots = new Map();
  const closed = [];
  for (const t of trades) {
    const key = t.mint;
    if (!lots.has(key)) lots.set(key, []);
    const q = lots.get(key);
    const amount = num(t.token_amount, 0);
    const usd = num(t.amount_usd, 0);
    if (t.side === 'buy') {
      q.push({ amountLeft: amount, amountBought: amount, costUsd: usd, entryTs: t.block_time, entryTrade: t });
      continue;
    }
    let sellLeft = amount;
    while (sellLeft > 1e-12 && q.length) {
      const lot = q[0];
      const matched = Math.min(sellLeft, lot.amountLeft);
      const cost = lot.costUsd * (matched / lot.amountBought);
      const proceeds = usd * (matched / amount);
      closed.push({
        mint: key,
        entry_ts: lot.entryTs,
        exit_ts: t.block_time,
        hold_min: (new Date(t.block_time) - new Date(lot.entryTs)) / 60000,
        buy_usd: cost,
        sell_usd: proceeds,
        pnl_usd: proceeds - cost,
        pnl_pct: cost > 0 ? (proceeds / cost - 1) * 100 : null,
        entry_trade: lot.entryTrade,
        exit_trade: t,
      });
      lot.amountLeft -= matched;
      sellLeft -= matched;
      if (lot.amountLeft <= 1e-12) q.shift();
    }
  }
  return closed;
}

async function profileWallet() {
  await ensureSchema();
  const trades = await loadWalletTrades();
  const closed = buildClosedPositions(trades);
  const entryMoves = [];
  for (const p of closed.slice(0, Number(process.env.DIP_PROFILE_MAX_ENTRY_CONTEXT || 250))) {
    const pct = await priceBeforePct(p.mint, p.entry_ts, 10);
    if (pct !== null) entryMoves.push({ mint: p.mint, entry_ts: p.entry_ts, pct });
  }
  const pnls = closed.map((p) => p.pnl_pct).filter((v) => v !== null);
  const holds = closed.map((p) => p.hold_min).filter((v) => Number.isFinite(v));
  const byMint = {};
  for (const p of closed) {
    byMint[p.mint] ||= { trades: 0, pnl_usd: 0, pnl_pct_sum: 0 };
    byMint[p.mint].trades++;
    byMint[p.mint].pnl_usd += p.pnl_usd;
    byMint[p.mint].pnl_pct_sum += p.pnl_pct || 0;
  }
  for (const v of Object.values(byMint)) v.avg_pnl_pct = v.trades ? v.pnl_pct_sum / v.trades : 0;

  return {
    wallet,
    raw_trades: trades.length,
    closed_lots: closed.length,
    holding_minutes: { median: quantile(holds, 0.5), p25: quantile(holds, 0.25), p75: quantile(holds, 0.75), p90: quantile(holds, 0.9) },
    entry_context_10m: {
      sample: entryMoves.length,
      median_price_change_pct: quantile(entryMoves.map((e) => e.pct), 0.5),
      dip_entries: entryMoves.filter((e) => e.pct <= -10).length,
      momentum_entries: entryMoves.filter((e) => e.pct >= 10).length,
    },
    exits: {
      tp_like: closed.filter((p) => (p.pnl_pct || 0) >= 20).length,
      sl_like: closed.filter((p) => (p.pnl_pct || 0) <= -15).length,
      timeout_like: closed.filter((p) => p.hold_min >= 90 && Math.abs(p.pnl_pct || 0) < 20).length,
    },
    pnl: {
      sum_usd: pnls.length ? closed.reduce((s, p) => s + p.pnl_usd, 0) : 0,
      avg_pct: pnls.length ? pnls.reduce((s, p) => s + p, 0) / pnls.length : null,
      median_pct: quantile(pnls, 0.5),
      p10_pct: quantile(pnls, 0.1),
      p90_pct: quantile(pnls, 0.9),
      win_rate_pct: pnls.length ? (pnls.filter((p) => p > 0).length / pnls.length) * 100 : null,
    },
    by_mint_top: Object.entries(byMint)
      .map(([mint, v]) => ({ mint, ...v }))
      .sort((a, b) => b.pnl_usd - a.pnl_usd)
      .slice(0, 25),
  };
}

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return Boolean(rows[0]?.t);
}

async function marketRows(profile) {
  const hasRoute = await tableExists('jupiter_route_snapshots');
  const snapshotTables = ['raydium_pair_snapshots', 'meteora_pair_snapshots', 'moonshot_pair_snapshots'];
  const existing = [];
  for (const t of snapshotTables) if (await tableExists(t)) existing.push(t);
  const unions = [
    `SELECT date_trunc('minute', block_time) AS ts, base_mint AS mint,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY price_usd) AS price_usd,
            SUM(amount_usd) AS volume_usd_5m,
            COUNT(*)::int AS trades_5m,
            COUNT(*) FILTER (WHERE side='buy')::int AS buys_5m,
            COUNT(*) FILTER (WHERE side='sell')::int AS sells_5m,
            NULL::double precision AS liquidity_usd
     FROM swaps
     WHERE block_time >= now() - ($1::int * interval '1 day')
       AND price_usd > 0 AND price_usd < 1000 AND base_mint <> $2
     GROUP BY 1, 2`,
  ];
  for (const t of existing) {
    unions.push(
      `SELECT ts, base_mint AS mint, price_usd,
              COALESCE(volume_5m, 0) AS volume_usd_5m,
              COALESCE(buys_5m, 0) + COALESCE(sells_5m, 0) AS trades_5m,
              COALESCE(buys_5m, 0) AS buys_5m,
              COALESCE(sells_5m, 0) AS sells_5m,
              liquidity_usd
       FROM ${t}
       WHERE ts >= now() - ($1::int * interval '1 day') AND price_usd > 0`,
    );
  }
  const routeJoin = hasRoute
    ? `LEFT JOIN LATERAL (
         SELECT routeable, estimated_slippage_bps
         FROM jupiter_route_snapshots j
         WHERE j.mint=e.mint AND j.ts <= e.ts
         ORDER BY j.ts DESC LIMIT 1
       ) j ON true`
    : 'LEFT JOIN LATERAL (SELECT NULL::boolean AS routeable, NULL::double precision AS estimated_slippage_bps) j ON true';

  const client = await pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS dip_market_tmp');
    await client.query(
      `CREATE TEMP TABLE dip_market_tmp AS
       WITH m AS (${unions.join('\nUNION ALL\n')})
       SELECT ts, mint,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY price_usd) AS price_usd,
              SUM(volume_usd_5m) AS volume_usd_5m,
              SUM(trades_5m)::int AS trades_5m,
              SUM(buys_5m)::int AS buys_5m,
              SUM(sells_5m)::int AS sells_5m,
              MAX(liquidity_usd) AS liquidity_usd
       FROM m
       GROUP BY 1, 2`,
      [lookbackDays, SOL_MINT],
    );
    await client.query('CREATE INDEX dip_market_tmp_mint_ts_idx ON dip_market_tmp (mint, ts)');

    const { rows } = await client.query(
      `WITH enriched AS (
         SELECT
           c.*,
           SUM(c.volume_usd_5m) OVER (
             PARTITION BY c.mint
             ORDER BY c.ts
             RANGE BETWEEN interval '59 minutes' PRECEDING AND CURRENT ROW
           ) AS volume_usd_1h,
           SUM(c.trades_5m) OVER (
             PARTITION BY c.mint
             ORDER BY c.ts
             RANGE BETWEEN interval '59 minutes' PRECEDING AND CURRENT ROW
           )::int AS trades_1h,
           SUM(c.buys_5m) OVER (
             PARTITION BY c.mint
             ORDER BY c.ts
             RANGE BETWEEN interval '59 minutes' PRECEDING AND CURRENT ROW
           )::int AS buys_1h,
           SUM(c.sells_5m) OVER (
             PARTITION BY c.mint
             ORDER BY c.ts
             RANGE BETWEEN interval '59 minutes' PRECEDING AND CURRENT ROW
           )::int AS sells_1h,
           SUM(c.buys_5m) OVER (
             PARTITION BY c.mint
             ORDER BY c.ts
             RANGE BETWEEN interval '359 minutes' PRECEDING AND CURRENT ROW
           )::int AS buys_6h,
           SUM(c.sells_5m) OVER (
             PARTITION BY c.mint
             ORDER BY c.ts
             RANGE BETWEEN interval '359 minutes' PRECEDING AND CURRENT ROW
           )::int AS sells_6h
         FROM dip_market_tmp c
       )
       SELECT e.*,
              prior.price_usd AS prior_price_usd,
              knife.price_usd AS knife_price_usd,
              j.routeable,
              j.estimated_slippage_bps
       FROM enriched e
       LEFT JOIN LATERAL (
         SELECT price_usd
         FROM dip_market_tmp p
         WHERE p.mint = e.mint
           AND p.ts <= e.ts - ($1::int * interval '1 minute')
         ORDER BY p.ts DESC
         LIMIT 1
       ) prior ON true
       LEFT JOIN LATERAL (
         SELECT price_usd
         FROM dip_market_tmp k
         WHERE k.mint = e.mint
           AND k.ts <= e.ts - ($2::int * interval '1 minute')
         ORDER BY k.ts DESC
         LIMIT 1
       ) knife ON true
       ${routeJoin}
       WHERE e.price_usd > 0
       ORDER BY e.ts, e.mint`,
      [profile.entry.lookbackMin, RUNNER_KNIFE_WINDOW_MIN],
    );
    await client.query('DROP TABLE IF EXISTS dip_market_tmp');
    return rows;
  } finally {
    await client.query('DROP TABLE IF EXISTS dip_market_tmp').catch(() => {});
    client.release();
  }
}

async function loadBtcSeries() {
  if (!BTC_MINTS.length) return [];
  const { rows } = await pool.query(
    `SELECT date_trunc('minute', block_time) AS ts,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY price_usd) AS price_usd
     FROM swaps
     WHERE base_mint = ANY($1::text[])
       AND block_time >= now() - (($2::int + 2) * interval '1 day')
       AND price_usd > 0
     GROUP BY 1
     ORDER BY 1`,
    [BTC_MINTS, lookbackDays],
  );
  return rows.map((r) => ({ tsMs: new Date(r.ts).getTime(), px: num(r.price_usd, 0) })).filter((r) => r.px > 0);
}

function priceAtOrBefore(series, tsMs) {
  if (!series.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].tsMs <= tsMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? series[ans].px : null;
}

function btcGateAt(series, ts) {
  if (!series.length) return { halt: false, missing: true, ret1hPct: null, ret4hPct: null };
  const tsMs = new Date(ts).getTime();
  const nowPx = priceAtOrBefore(series, tsMs);
  const px1h = priceAtOrBefore(series, tsMs - 60 * 60000);
  const px4h = priceAtOrBefore(series, tsMs - 240 * 60000);
  if (!nowPx || !px1h || !px4h) return { halt: false, missing: true, ret1hPct: null, ret4hPct: null };
  const ret1hPct = (nowPx / px1h - 1) * 100;
  const ret4hPct = (nowPx / px4h - 1) * 100;
  const halt = ret1hPct <= BTC_HALT_1H_PCT || ret4hPct <= BTC_HALT_4H_PCT;
  return { halt, missing: false, ret1hPct, ret4hPct };
}

async function loadMintIntel(mints) {
  const out = new Map();
  if (!mints.length) return out;

  const { rows: tokenRows } = await pool.query(
    `SELECT mint, holder_count, liquidity_usd, fdv_usd, dev_wallet, first_seen_at
     FROM tokens
     WHERE mint = ANY($1::text[])`,
    [mints],
  );
  for (const r of tokenRows) {
    out.set(r.mint, {
      holder_count: num(r.holder_count, null),
      liquidity_usd: num(r.liquidity_usd, null),
      fdv_usd: num(r.fdv_usd, null),
      dev_wallet: r.dev_wallet || null,
      first_seen_at: r.first_seen_at || null,
      authority_wallets: [],
      tx_burst_count: null,
      scam_wallet_hits: [],
    });
  }
  for (const mint of mints) if (!out.has(mint)) out.set(mint, { authority_wallets: [], scam_wallet_hits: [] });

  const hasRpcFeatures = await tableExists('rpc_features');
  if (!hasRpcFeatures) return out;

  const { rows: featureRows } = await pool.query(
    `WITH ranked AS (
       SELECT mint, feature_type, data, feature_ts,
              ROW_NUMBER() OVER (PARTITION BY mint, feature_type ORDER BY feature_ts DESC) AS rn
       FROM rpc_features
       WHERE mint = ANY($1::text[])
         AND feature_type IN ('authorities', 'tx_burst')
     )
     SELECT mint, feature_type, data
     FROM ranked
     WHERE rn = 1`,
    [mints],
  );
  for (const f of featureRows) {
    const cur = out.get(f.mint) || { authority_wallets: [], scam_wallet_hits: [] };
    if (f.feature_type === 'authorities') {
      cur.authority_wallets = extractAddresses(f.data);
    } else if (f.feature_type === 'tx_burst') {
      cur.tx_burst_count = Array.isArray(f.data) ? f.data.length : null;
    }
    out.set(f.mint, cur);
  }

  const wallets = new Set();
  for (const v of out.values()) {
    if (v.dev_wallet) wallets.add(v.dev_wallet);
    for (const w of v.authority_wallets || []) wallets.add(w);
  }
  if (!wallets.size) return out;
  const hasEntityWallets = await tableExists('entity_wallets');
  if (!hasEntityWallets) return out;

  const { rows: walletRows } = await pool.query(
    `SELECT wallet, primary_tag
     FROM entity_wallets
     WHERE wallet = ANY($1::text[])`,
    [[...wallets]],
  );
  const tagMap = new Map(walletRows.map((r) => [r.wallet, r.primary_tag]));
  for (const [mint, v] of out.entries()) {
    const suspects = [];
    if (v.dev_wallet) {
      const tag = tagMap.get(v.dev_wallet);
      if (SCAM_PRIMARY_TAGS.has(tag)) suspects.push({ wallet: v.dev_wallet, role: 'dev_wallet', tag });
    }
    for (const a of v.authority_wallets || []) {
      const tag = tagMap.get(a);
      if (SCAM_PRIMARY_TAGS.has(tag)) suspects.push({ wallet: a, role: 'authority', tag });
    }
    v.scam_wallet_hits = suspects;
    out.set(mint, v);
  }
  return out;
}

function runnerGate(row, intel) {
  const holders = num(intel.holder_count, null);
  if (REQUIRE_INTEL_FIELDS && holders === null) return { pass: false, reason: 'intel_missing_holders', details: { required: true } };
  if (holders !== null && holders < RUNNER_MIN_HOLDERS) return { pass: false, reason: 'holders', details: { holders, min: RUNNER_MIN_HOLDERS } };

  const firstSeen = intel.first_seen_at ? new Date(intel.first_seen_at).getTime() : null;
  if (REQUIRE_INTEL_FIELDS && !firstSeen) return { pass: false, reason: 'intel_missing_age', details: { required: true } };
  const ageHours = firstSeen ? (new Date(row.ts).getTime() - firstSeen) / 3_600_000 : null;
  if (ageHours !== null && ageHours < RUNNER_MIN_AGE_HOURS) return { pass: false, reason: 'age_too_fresh', details: { ageHours, min: RUNNER_MIN_AGE_HOURS } };
  if (ageHours !== null && ageHours > RUNNER_MAX_AGE_HOURS) return { pass: false, reason: 'age_too_old', details: { ageHours, max: RUNNER_MAX_AGE_HOURS } };

  const liq = num(intel.liquidity_usd ?? row.liquidity_usd, null);
  const fdv = num(intel.fdv_usd, null);
  if (REQUIRE_INTEL_FIELDS && liq === null) return { pass: false, reason: 'intel_missing_liquidity', details: { required: true } };
  if (REQUIRE_INTEL_FIELDS && fdv === null) return { pass: false, reason: 'intel_missing_fdv', details: { required: true } };
  const lpToFdv = liq !== null && fdv && fdv > 0 ? liq / fdv : null;
  if (lpToFdv !== null && lpToFdv < RUNNER_MIN_LP_TO_FDV) {
    return { pass: false, reason: 'lp_to_fdv', details: { lpToFdv, min: RUNNER_MIN_LP_TO_FDV, liquidityUsd: liq, fdvUsd: fdv } };
  }

  const vol1h = num(row.volume_usd_1h, 0);
  const vol1m = num(row.volume_usd_5m, 0) / 5;
  const trades1h = num(row.trades_1h, 0);
  const buys1h = num(row.buys_1h, 0);
  const sells1h = num(row.sells_1h, 0);
  const buys6h = num(row.buys_6h, 0);
  const sells6h = num(row.sells_6h, 0);
  const knifePrior = num(row.knife_price_usd, null);
  const knifeDropPct = knifePrior && knifePrior > 0 ? (num(row.price_usd, 0) / knifePrior - 1) * 100 : null;

  if (vol1h < RUNNER_MIN_VOLUME_1H_USD) return { pass: false, reason: 'volume_1h', details: { vol1h, min: RUNNER_MIN_VOLUME_1H_USD } };
  if (vol1m < RUNNER_MIN_VOLUME_1M_USD) return { pass: false, reason: 'volume_1m', details: { vol1m, min: RUNNER_MIN_VOLUME_1M_USD } };
  if (trades1h < RUNNER_MIN_TRADES_1H) return { pass: false, reason: 'trades_1h', details: { trades1h, min: RUNNER_MIN_TRADES_1H } };
  if (buys1h < RUNNER_MIN_BUYS_1H) return { pass: false, reason: 'buys_1h', details: { buys1h, min: RUNNER_MIN_BUYS_1H } };
  if (sells1h < RUNNER_MIN_SELLS_1H) return { pass: false, reason: 'sells_1h', details: { sells1h, min: RUNNER_MIN_SELLS_1H } };
  if (knifeDropPct !== null && knifeDropPct <= RUNNER_KNIFE_MAX_DROP_PCT) {
    return { pass: false, reason: 'falling_knife', details: { knifeDropPct, min: RUNNER_KNIFE_MAX_DROP_PCT, knifeWindowMin: RUNNER_KNIFE_WINDOW_MIN } };
  }

  if (buys1h >= RUNNER_HONEYPOT_MIN_BUYS_1H && sells1h === 0) {
    return { pass: false, reason: 'honeypot_h1', details: { buys1h, sells1h } };
  }
  const sellBuyRatio6h = sells6h / Math.max(buys6h, 1);
  if (buys6h >= RUNNER_HONEYPOT_MIN_BUYS_6H && sellBuyRatio6h < RUNNER_MIN_SELL_BUY_RATIO_6H) {
    return { pass: false, reason: 'near_honeypot_h6', details: { buys6h, sells6h, sellBuyRatio6h, min: RUNNER_MIN_SELL_BUY_RATIO_6H } };
  }

  if (Array.isArray(intel.scam_wallet_hits) && intel.scam_wallet_hits.length > 0) {
    return { pass: false, reason: 'scam_wallet_tag', details: { hits: intel.scam_wallet_hits.slice(0, 5) } };
  }

  return {
    pass: true,
    details: {
      holders,
      ageHours,
      liquidityUsd: liq,
      fdvUsd: fdv,
      lpToFdv,
      volume1hUsd: vol1h,
      volume1mUsd: vol1m,
      knifeDropPct,
      buys1h,
      sells1h,
      buys6h,
      sells6h,
      txBurstCount: intel.tx_burst_count ?? null,
    },
  };
}

function simulateExit(points, entryIdx, profile) {
  if (entryIdx >= points.length - 1) return null;
  const entry = points[entryIdx];
  const entryPx = num(entry.price_usd, 0);
  if (!(entryPx > 0)) return null;

  let qty = positionUsd / entryPx;
  let costBasisUsd = positionUsd;
  let grossInvestedUsd = positionUsd;
  let realizedValueUsd = 0;
  let realizedPnlUsd = 0;
  let turnoverUsd = positionUsd;
  let tpHits = 0;
  let peakAfterTrail = null;
  let exitPoint = points[Math.min(points.length - 1, entryIdx)];
  let exitReason = 'EOD';

  const dcaLevels = [...(profile.dca?.levels || [])].sort((a, b) => a.triggerPct - b.triggerPct);
  let dcaIdx = 0;
  const tpLadder = [...(profile.exit?.tpLadder || [])].sort((a, b) => a.pnlPct - b.pnlPct);
  let tpIdx = 0;
  const events = [];

  const sellFraction = (p, fraction, reason) => {
    if (fraction <= 0 || qty <= 1e-12) return;
    const px = num(p.price_usd, 0);
    if (!(px > 0)) return;
    const useFraction = Math.min(1, Math.max(0, fraction));
    const sellQty = qty * useFraction;
    const proceeds = sellQty * px;
    const allocatedCost = costBasisUsd * useFraction;
    realizedValueUsd += proceeds;
    realizedPnlUsd += proceeds - allocatedCost;
    turnoverUsd += proceeds;
    qty -= sellQty;
    costBasisUsd -= allocatedCost;
    events.push({ ts: p.ts, kind: 'sell', reason, sell_fraction: useFraction, proceeds_usd: proceeds, pnl_usd: proceeds - allocatedCost });
  };

  for (let i = entryIdx + 1; i < points.length; i++) {
    const p = points[i];
    const px = num(p.price_usd, 0);
    const ageMin = (new Date(p.ts) - new Date(entry.ts)) / 60000;
    if (!(px > 0) || ageMin < 0) continue;

    exitPoint = p;
    const mtmValueUsd = realizedValueUsd + qty * px;
    const totalPnlPct = grossInvestedUsd > 0 ? mtmValueUsd / grossInvestedUsd - 1 : 0;
    const openPnlPct = qty > 1e-12 && costBasisUsd > 0 ? (qty * px) / costBasisUsd - 1 : 0;

    while (profile.dca?.enabled && dcaIdx < dcaLevels.length && qty > 1e-12) {
      const lvl = dcaLevels[dcaIdx];
      if (openPnlPct > lvl.triggerPct) break;
      const aliveEnough =
        !profile.dca.requireAliveForAdd ||
        (num(p.volume_usd_1h, 0) >= RUNNER_MIN_VOLUME_1H_USD &&
          num(p.buys_1h, 0) >= RUNNER_MIN_BUYS_1H &&
          num(p.sells_1h, 0) >= RUNNER_MIN_SELLS_1H);
      if (!aliveEnough) {
        dcaIdx++;
        events.push({ ts: p.ts, kind: 'dca_skip', reason: 'not_alive_enough', trigger_pct: lvl.triggerPct });
        continue;
      }
      const addUsd = positionUsd * lvl.addFraction;
      qty += addUsd / px;
      costBasisUsd += addUsd;
      grossInvestedUsd += addUsd;
      turnoverUsd += addUsd;
      events.push({ ts: p.ts, kind: 'buy_add', trigger_pct: lvl.triggerPct, add_usd: addUsd, add_fraction: lvl.addFraction });
      dcaIdx++;
    }

    if (totalPnlPct <= num(profile.dca?.killStopPct, -1)) {
      sellFraction(p, 1, 'KILL_STOP');
      exitReason = 'KILL_STOP';
      break;
    }
    if (openPnlPct <= num(profile.exit?.stopLossPct, -1)) {
      sellFraction(p, 1, 'SL');
      exitReason = 'SL';
      break;
    }

    while (tpIdx < tpLadder.length && totalPnlPct >= tpLadder[tpIdx].pnlPct && qty > 1e-12) {
      sellFraction(p, tpLadder[tpIdx].sellFraction, `TP_${Math.round(tpLadder[tpIdx].pnlPct * 100)}`);
      tpIdx++;
      tpHits = tpIdx;
    }

    if (tpHits >= num(profile.exit?.trailActivateAfterTp, 99) && qty > 1e-12) {
      peakAfterTrail = peakAfterTrail === null ? px : Math.max(peakAfterTrail, px);
      const drawdown = peakAfterTrail > 0 ? px / peakAfterTrail - 1 : 0;
      if (drawdown <= -num(profile.exit?.trailDropPct, 1)) {
        sellFraction(p, 1, 'TRAIL');
        exitReason = 'TRAIL';
        break;
      }
    }

    if (ageMin >= num(profile.exit?.timeoutMin, 120)) {
      sellFraction(p, 1, 'TIMEOUT');
      exitReason = 'TIMEOUT';
      break;
    }
  }

  if (qty > 1e-12) {
    sellFraction(exitPoint, 1, 'EOD');
    if (exitReason === 'EOD') exitReason = 'EOD';
  }

  const totalCostsUsd = turnoverUsd * (num(profile.costs?.feeBps, 0) + num(profile.costs?.slippageBps, 0)) / 10000;
  const netPnlUsd = realizedPnlUsd - totalCostsUsd;
  const grossPnlPct = grossInvestedUsd > 0 ? (realizedPnlUsd / grossInvestedUsd) * 100 : 0;
  const netPnlPct = grossInvestedUsd > 0 ? (netPnlUsd / grossInvestedUsd) * 100 : 0;

  return {
    exit_ts: exitPoint.ts,
    exit_price_usd: num(exitPoint.price_usd, entryPx),
    exit_reason: exitReason,
    gross_pnl_pct: grossPnlPct,
    net_pnl_pct: netPnlPct,
    pnl_usd: netPnlUsd,
    invested_usd: grossInvestedUsd,
    execution_cost_usd: totalCostsUsd,
    events: events.slice(0, 20),
  };
}

async function evalProfile(profile, rows, btcSeries) {
  const mints = [...new Set(rows.map((r) => r.mint))];
  const mintIntel = await loadMintIntel(mints);
  const byMint = new Map();
  for (const r of rows) {
    if (!byMint.has(r.mint)) byMint.set(r.mint, []);
    byMint.get(r.mint).push(r);
  }
  const candidates = [];
  const gateRejects = {};
  let skippedByMintCap = 0;
  let btcMissingPoints = 0;
  for (const points of byMint.values()) {
    points.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    for (let i = 0; i < points.length; i++) {
      const r = points[i];
      const px = num(r.price_usd);
      const prior = num(r.prior_price_usd);
      if (!px || !prior) continue;
      const dipPct = (px / prior - 1) * 100;
      const liquidity = num(r.liquidity_usd, profile.entry.minLiquidityUsd);
      const routeable = r.routeable === null || r.routeable === undefined ? !profile.entry.requireRouteable : r.routeable;
      const slip = num(r.estimated_slippage_bps, 0);
      const gate = runnerGate(r, mintIntel.get(r.mint) || {});
      const btc = btcGateAt(btcSeries, r.ts);
      if (dipPct > profile.entry.dipPct) continue;
      if (liquidity < profile.entry.minLiquidityUsd) continue;
      if (num(r.volume_usd_5m, 0) < profile.entry.minVolumeUsd5m) continue;
      if (num(r.trades_5m, 0) < profile.entry.minTrades5m) continue;
      if (profile.entry.requireRouteable && !routeable) continue;
      if (slip > profile.entry.maxSlippageBps) continue;
      if (btc.missing) btcMissingPoints++;
      if (btc.halt) {
        gateRejects.btc_risk_off = (gateRejects.btc_risk_off || 0) + 1;
        continue;
      }
      if (!gate.pass) {
        gateRejects[gate.reason] = (gateRejects[gate.reason] || 0) + 1;
        continue;
      }
      candidates.push({
        points,
        idx: i,
        row: r,
        dipPct,
        runner: gate.details,
        btc: { ret1hPct: btc.ret1hPct, ret4hPct: btc.ret4hPct },
      });
    }
  }
  candidates.sort((a, b) => new Date(a.row.ts) - new Date(b.row.ts));

  const trades = [];
  const openUntil = [];
  const cooldown = new Map();
  const mintEntryWindow = new Map();
  for (const c of candidates) {
    const tsMs = new Date(c.row.ts).getTime();
    while (openUntil.length && openUntil[0] <= tsMs) openUntil.shift();
    if (openUntil.length >= profile.risk.maxOpen) continue;
    if ((cooldown.get(c.row.mint) || 0) > tsMs) continue;
    const windowMs = ENTRIES_PER_MINT_WINDOW_MIN * 60000;
    const mintTimes = mintEntryWindow.get(c.row.mint) || [];
    const freshTimes = mintTimes.filter((t) => tsMs - t <= windowMs);
    if (freshTimes.length >= MAX_ENTRIES_PER_MINT_WINDOW) {
      skippedByMintCap++;
      continue;
    }
    const ex = simulateExit(c.points, c.idx, profile);
    if (!ex) continue;
    cooldown.set(c.row.mint, tsMs + profile.entry.cooldownMin * 60000);
    freshTimes.push(tsMs);
    mintEntryWindow.set(c.row.mint, freshTimes);
    openUntil.push(new Date(ex.exit_ts).getTime());
    openUntil.sort((a, b) => a - b);
    trades.push({
      mint: c.row.mint,
      entry_ts: c.row.ts,
      entry_price_usd: c.row.price_usd,
      dip_pct: c.dipPct,
      runner: c.runner,
      btc: c.btc,
      ...ex,
    });
  }

  const pnls = trades.map((t) => t.net_pnl_pct);
  const pnlUsd = trades.map((t) => t.pnl_usd);
  return {
    id: profile.id,
    config: profile,
    trades: trades.length,
    win_rate_pct: pnls.length ? (pnls.filter((p) => p > 0).length / pnls.length) * 100 : 0,
    avg_pnl_pct: pnls.length ? pnls.reduce((s, p) => s + p, 0) / pnls.length : 0,
    median_pnl_pct: quantile(pnls, 0.5),
    sum_pnl_usd: pnlUsd.reduce((s, p) => s + p, 0),
    max_drawdown_usd: maxDrawdown(pnlUsd),
    runner_gate: {
      min_holders: RUNNER_MIN_HOLDERS,
      min_age_hours: RUNNER_MIN_AGE_HOURS,
      max_age_hours: RUNNER_MAX_AGE_HOURS,
      min_lp_to_fdv: RUNNER_MIN_LP_TO_FDV,
      min_volume_1h_usd: RUNNER_MIN_VOLUME_1H_USD,
      min_volume_1m_usd: RUNNER_MIN_VOLUME_1M_USD,
      min_trades_1h: RUNNER_MIN_TRADES_1H,
      min_buys_1h: RUNNER_MIN_BUYS_1H,
      min_sells_1h: RUNNER_MIN_SELLS_1H,
      knife_window_min: RUNNER_KNIFE_WINDOW_MIN,
      knife_max_drop_pct: RUNNER_KNIFE_MAX_DROP_PCT,
      btc_halt_1h_pct: BTC_HALT_1H_PCT,
      btc_halt_4h_pct: BTC_HALT_4H_PCT,
      btc_mints: BTC_MINTS,
      btc_missing_points: btcMissingPoints,
      require_intel_fields: REQUIRE_INTEL_FIELDS,
      max_entries_per_mint_window: MAX_ENTRIES_PER_MINT_WINDOW,
      entries_per_mint_window_min: ENTRIES_PER_MINT_WINDOW_MIN,
      skipped_by_mint_window_cap: skippedByMintCap,
      scam_tags: [...SCAM_PRIMARY_TAGS],
      rejected_by_reason: gateRejects,
    },
    exits: trades.reduce((acc, t) => ((acc[t.exit_reason] = (acc[t.exit_reason] || 0) + 1), acc), {}),
    sample_trades: trades.slice(0, 20),
  };
}

async function backtestDip() {
  const btcSeries = await loadBtcSeries();
  const results = [];
  for (const profile of PROFILES) {
    const rows = await marketRows(profile);
    results.push(await evalProfile(profile, rows, btcSeries));
  }
  return results.sort((a, b) => b.sum_pnl_usd - a.sum_pnl_usd);
}

async function smokeBacktest() {
  const checks = {
    started_at: new Date().toISOString(),
    required_tables: {},
    temp_table_roundtrip: null,
    swaps_last_days_rows: 0,
    btc_series_points: 0,
    market_rows: {},
    eval_samples: {},
  };

  const required = ['swaps', 'tokens'];
  for (const t of required) checks.required_tables[t] = await tableExists(t);
  if (!checks.required_tables.swaps) throw new Error('smoke: required table missing: swaps');

  const c = await pool.connect();
  try {
    await c.query('CREATE TEMP TABLE dip_smoke_tmp(x int)');
    await c.query('INSERT INTO dip_smoke_tmp(x) VALUES (1)');
    const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM dip_smoke_tmp');
    checks.temp_table_roundtrip = num(rows[0]?.n, 0);
  } finally {
    c.release();
  }
  if (checks.temp_table_roundtrip !== 1) throw new Error('smoke: temp table roundtrip failed');

  const { rows: swapCountRows } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM swaps
     WHERE block_time >= now() - ($1::int * interval '1 day')`,
    [lookbackDays],
  );
  checks.swaps_last_days_rows = num(swapCountRows[0]?.n, 0);
  if (checks.swaps_last_days_rows <= 0) throw new Error(`smoke: no swaps in last ${lookbackDays}d`);

  const btcSeries = await loadBtcSeries();
  checks.btc_series_points = btcSeries.length;

  const maxRows = Number(process.env.DIP_SMOKE_MAX_ROWS || 3000);
  for (const p of PROFILES) {
    const rows = await marketRows(p);
    checks.market_rows[p.id] = rows.length;
    if (!rows.length) continue;
    const sliced = rows.slice(-maxRows);
    const evalRes = await evalProfile(p, sliced, btcSeries);
    checks.eval_samples[p.id] = {
      rows_used: sliced.length,
      trades: evalRes.trades,
      sum_pnl_usd: evalRes.sum_pnl_usd,
      max_drawdown_usd: evalRes.max_drawdown_usd,
    };
  }

  checks.finished_at = new Date().toISOString();
  checks.ok = true;
  return checks;
}

function baselinePaper() {
  const store = process.env.PAPER_TRADES_PATH || '/opt/solana-alpha/data/paper-trades.jsonl';
  if (!fs.existsSync(store)) return { source: store, trades: 0, note: 'paper JSONL not found on this machine' };
  const lines = fs.readFileSync(store, 'utf8').split('\n').filter(Boolean);
  const closes = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.kind === 'close') closes.push(e);
    } catch {}
  }
  const pnls = closes.map((c) => num(c.pnlPct)).filter((v) => v !== null);
  return {
    source: store,
    trades: pnls.length,
    win_rate_pct: pnls.length ? (pnls.filter((p) => p > 0).length / pnls.length) * 100 : 0,
    avg_pnl_pct: pnls.length ? pnls.reduce((s, p) => s + p, 0) / pnls.length : 0,
    median_pnl_pct: quantile(pnls, 0.5),
  };
}

async function main() {
  const output = { generated_at: new Date().toISOString(), wallet, lookback_days: lookbackDays };
  if (cmd === 'schema') output.schema = await ensureSchema().then(() => ({ ok: true }));
  else if (cmd === 'backfill') output.backfill = await backfillWallet();
  else if (cmd === 'profile') output.profile = await profileWallet();
  else if (cmd === 'smoke') output.smoke = await smokeBacktest();
  else if (cmd === 'backtest') output.backtest = await backtestDip();
  else if (cmd === 'baseline') output.baseline = baselinePaper();
  else if (cmd === 'all') {
    output.backfill = process.env.DIP_SKIP_BACKFILL === '1' ? { skipped: true } : await backfillWallet();
    output.profile = await profileWallet();
    output.backtest = await backtestDip();
    output.baseline = baselinePaper();
    output.recommendation = {
      profile: 'balanced',
      reason: 'Balanced starts with routeability/liquidity gates and controlled downside; use backtest ranking to override only if conservative materially outperforms after fees.',
      paper_config: 'scripts-tmp/dip-paper-config.json',
    };
  } else {
    throw new Error(`unknown command "${cmd}". Use schema|backfill|profile|smoke|backtest|baseline|all`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
