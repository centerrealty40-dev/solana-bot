/**
 * Live Paper-Trader (forward test)
 * =================================
 *
 * Что делает:
 *   1. Раз в 30 сек ищет в `tokens` (заполняется pp:collector'ом) свежие
 *      pump.fun mints возрастом 7..12 мин, которые ещё не оценивали.
 *   2. Для каждого через Helius тащит транзакции на bondingCurvePDA, считает
 *      метрики в окне [2..7 мин] и применяет STRICT-фильтры (как в retro).
 *   3. Если PASS → открывает paper-trade: фиксирует entry_mc_usd и пишет
 *      строку в JSONL.
 *   4. Раз в 60 сек обходит open trades, через pump.fun /coins/{mint} тянет
 *      текущий market_cap_usd, обновляет peak. Закрывает на:
 *        TP  ≥ +200%   (3x)
 *        SL  ≤ -50%
 *        TRAIL — после касания 2x: -40% от пика
 *        TIMEOUT — по истечении 12 часов
 *   5. Раз в 5 мин печатает summary: открытий / закрытий / win rate / avg PnL.
 *
 * Storage: append-only JSONL `/tmp/paper-trades.jsonl` — все события
 *   (open / update / close). Restart-friendly: при старте перечитываем
 *   и восстанавливаем open positions.
 *
 * Запуск:
 *   npm run paper:live                  -- forever (запусти под pm2)
 *   npm run paper:live -- --dry-run     -- только discovery, без трейдов
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { fetch } from 'undici';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY!;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

// =====================================================================
// CONFIG
// =====================================================================
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WSOL = 'So11111111111111111111111111111111111111112';

// — детектор (mirror retro-validator STRICT)
const FILTERS = {
  MIN_UNIQUE_BUYERS: 20,
  MIN_BUY_SOL: 5,
  MIN_BUY_SELL_RATIO: 1.5,
  MAX_TOP_BUYER_SHARE: 0.35,
  MIN_BC_PROGRESS: 0.25,
  MAX_BC_PROGRESS: 0.95,
};
const BC_GRADUATION_SOL = 85;

// — окно
const WINDOW_START_MIN = 2;
const DECISION_AGE_MIN = 7;
const DECISION_AGE_MAX_MIN = 12;     // если позже — пропускаем (поздно входить)

// — exit
const TP_X = 3.0;                    // +200%
const SL_X = 0.5;                    // -50%
const TRAIL_DROP = 0.4;              // -40% от пика после 2x
const TRAIL_TRIGGER_X = 2.0;         // включаем trailing только после 2x
const TIMEOUT_HOURS = 12;

// — частоты
const DISCOVERY_INTERVAL_MS = 30_000;
const TRACK_INTERVAL_MS = 60_000;
const STATS_INTERVAL_MS = 5 * 60_000;

const STORE_PATH = '/tmp/paper-trades.jsonl';

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

function bondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_FUN_PROGRAM,
  );
  return pda.toBase58();
}

// =====================================================================
// HELIUS
// =====================================================================
interface Txn {
  signature: string;
  timestamp: number;
  feePayer: string;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
  tokenTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; mint: string; tokenAmount: number }>;
  events?: { swap?: any };
}

async function fetchEarlyBcTxns(bcAddr: string, maxPages = 4): Promise<Txn[]> {
  const collected: Txn[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const url = `https://api.helius.xyz/v0/addresses/${bcAddr}/transactions?api-key=${HELIUS_KEY}&limit=100${cursor ? `&before=${cursor}` : ''}`;
    const data = await fetchJson<Txn[]>(url, 2);
    const page: Txn[] = Array.isArray(data) ? data : [];
    if (page.length === 0) break;
    collected.push(...page);
    cursor = page[page.length - 1].signature;
    await sleep(150);
  }
  collected.sort((a, b) => a.timestamp - b.timestamp);
  return collected;
}

interface Trade { ts: number; signer: string; side: 'buy' | 'sell'; solAmount: number; tokenAmount: number; }

function parseTrade(tx: Txn, mint: string, bondingCurve: string): Trade | null {
  const signer = tx.feePayer;
  const ts = tx.timestamp * 1000;

  const sw = tx.events?.swap;
  if (sw) {
    const nIn = Number(sw.nativeInput?.amount ?? 0) / 1e9;
    const nOut = Number(sw.nativeOutput?.amount ?? 0) / 1e9;
    const tInOurs = (sw.tokenInputs ?? []).find((t: any) => t.mint === mint);
    const tOutOurs = (sw.tokenOutputs ?? []).find((t: any) => t.mint === mint);
    const tokenAmt = (t: any): number =>
      t ? Number(t.rawTokenAmount?.tokenAmount ?? 0) / Math.pow(10, t.rawTokenAmount?.decimals ?? 6) : 0;
    if (nIn > 0 && tOutOurs) return { ts, signer, side: 'buy', solAmount: nIn, tokenAmount: tokenAmt(tOutOurs) };
    if (nOut > 0 && tInOurs) return { ts, signer, side: 'sell', solAmount: nOut, tokenAmount: tokenAmt(tInOurs) };
  }

  let solDir: 1 | -1 | 0 = 0; let solAmount = 0;
  for (const nt of tx.nativeTransfers ?? []) {
    if (nt.fromUserAccount === signer && nt.toUserAccount === bondingCurve) {
      solDir = 1; solAmount = Math.max(solAmount, nt.amount / 1e9);
    } else if (nt.fromUserAccount === bondingCurve && nt.toUserAccount === signer) {
      solDir = -1; solAmount = Math.max(solAmount, nt.amount / 1e9);
    }
  }
  if (solDir !== 0 && solAmount > 0) {
    let tokenAmount = 0;
    for (const tt of tx.tokenTransfers ?? []) {
      if (tt.mint !== mint) continue;
      const amt = Number(tt.tokenAmount ?? 0);
      if (amt > tokenAmount) tokenAmount = amt;
    }
    if (tokenAmount > 0) return { ts, signer, side: solDir > 0 ? 'buy' : 'sell', solAmount, tokenAmount };
  }

  let wsolDir: 1 | -1 | 0 = 0; let wsolAmt = 0;
  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.mint !== WSOL) continue;
    const amt = Number(tt.tokenAmount ?? 0);
    if (tt.fromUserAccount === signer && amt > 0) { wsolDir = 1; wsolAmt = Math.max(wsolAmt, amt); }
    else if (tt.toUserAccount === signer && amt > 0) { wsolDir = -1; wsolAmt = Math.max(wsolAmt, amt); }
  }
  if (wsolDir !== 0 && wsolAmt > 0) {
    let tokenAmount = 0;
    for (const tt of tx.tokenTransfers ?? []) {
      if (tt.mint !== mint) continue;
      const amt = Number(tt.tokenAmount ?? 0);
      if (amt > tokenAmount) tokenAmount = amt;
    }
    if (tokenAmount > 0) return { ts, signer, side: wsolDir > 0 ? 'buy' : 'sell', solAmount: wsolAmt, tokenAmount };
  }

  return null;
}

// =====================================================================
// METRICS + EVALUATE
// =====================================================================
interface Metrics {
  uniqueBuyers: number; uniqueSellers: number;
  sumBuySol: number; sumSellSol: number;
  topBuyerShare: number; bcProgress: number;
}
function computeMetrics(trades: Trade[]): Metrics {
  const buyers = new Map<string, number>();
  const sellers = new Set<string>();
  let sumBuy = 0, sumSell = 0;
  for (const t of trades) {
    if (t.side === 'buy') {
      buyers.set(t.signer, (buyers.get(t.signer) ?? 0) + t.solAmount);
      sumBuy += t.solAmount;
    } else {
      sellers.add(t.signer);
      sumSell += t.solAmount;
    }
  }
  let topShare = 0;
  if (sumBuy > 0) {
    let topVal = 0;
    for (const v of buyers.values()) if (v > topVal) topVal = v;
    topShare = topVal / sumBuy;
  }
  const bcProgress = Math.max(0, Math.min(1, (sumBuy - sumSell) / BC_GRADUATION_SOL));
  return { uniqueBuyers: buyers.size, uniqueSellers: sellers.size, sumBuySol: sumBuy, sumSellSol: sumSell, topBuyerShare: topShare, bcProgress };
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

// =====================================================================
// PAPER TRADE STORE
// =====================================================================
type ExitReason = 'TP' | 'SL' | 'TRAIL' | 'TIMEOUT' | 'NO_DATA';
interface OpenTrade {
  mint: string; symbol: string;
  entryTs: number;            // ms
  entryMcUsd: number;
  entryMetrics: Metrics;
  peakMcUsd: number;          // обновляется trackerom
  peakPnlPct: number;
  trailingArmed: boolean;
}
interface ClosedTrade extends OpenTrade {
  exitTs: number;
  exitMcUsd: number;
  exitReason: ExitReason;
  pnlPct: number;
  durationMin: number;
}

const open = new Map<string, OpenTrade>();
const closed: ClosedTrade[] = [];
const evaluatedMints = new Set<string>();        // already PASS/FAIL — не оценивать второй раз

function append(event: Record<string, any>): void {
  try {
    fs.appendFileSync(STORE_PATH, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
  } catch (err) {
    console.warn(`store write failed: ${err}`);
  }
}

function loadStore(): void {
  if (!fs.existsSync(STORE_PATH)) return;
  const lines = fs.readFileSync(STORE_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln);
      if (e.kind === 'eval') evaluatedMints.add(e.mint);
      if (e.kind === 'open') {
        open.set(e.mint, {
          mint: e.mint, symbol: e.symbol, entryTs: e.entryTs, entryMcUsd: e.entryMcUsd,
          entryMetrics: e.entryMetrics, peakMcUsd: e.entryMcUsd, peakPnlPct: 0, trailingArmed: false,
        });
      }
      if (e.kind === 'close') {
        open.delete(e.mint);
        closed.push(e as ClosedTrade);
      }
    } catch {}
  }
  console.log(`[store] loaded: ${evaluatedMints.size} evaluated, ${open.size} open, ${closed.length} closed`);
}

// =====================================================================
// DISCOVERY: fresh mints from `tokens` table (filled by pp:collector)
// =====================================================================
interface FreshMint { mint: string; symbol: string; bondingCurve: string; firstSeenAt: Date;
                      preBuyers: number; preBuyUsd: number; }

// Pre-filter thresholds: бесплатно через нашу БД отбраковываем явно мёртвые,
//   ДО того как тратить Helius credits. STRICT-фильтр требует ≥20 buyers и ≥5 SOL.
//   Если в нашей БД даже 5 buyers нет — токен точно не runner.
const PRE_MIN_BUYERS = 5;
const PRE_MIN_BUY_USD = 300;     // ~3 SOL @ $100/SOL

async function fetchFreshMints(): Promise<FreshMint[]> {
  // Один JOIN-запрос: tokens × swaps в окне [first_seen+2..+7 мин],
  //   считаем уникальных buyers и сумму buy USD.
  const r: any = await db.execute(dsql.raw(`
    WITH fresh AS (
      SELECT mint, symbol, first_seen_at, metadata
      FROM tokens
      WHERE first_seen_at < now() - interval '${DECISION_AGE_MIN} minutes'
        AND first_seen_at > now() - interval '${DECISION_AGE_MAX_MIN} minutes'
        AND metadata->>'source' = 'pumpportal'
      ORDER BY first_seen_at ASC
      LIMIT 200
    )
    SELECT
      f.mint, f.symbol, f.first_seen_at, f.metadata,
      COALESCE(a.buyers, 0)::int AS pre_buyers,
      COALESCE(a.buy_usd, 0)::float AS pre_buy_usd
    FROM fresh f
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT s.wallet) AS buyers,
        SUM(s.amount_usd)        AS buy_usd
      FROM swaps s
      WHERE s.base_mint = f.mint
        AND s.side = 'buy'
        AND s.block_time >= f.first_seen_at + interval '${WINDOW_START_MIN} minutes'
        AND s.block_time <= f.first_seen_at + interval '${DECISION_AGE_MIN} minutes'
        AND s.amount_usd >= 20
    ) a ON true
  `));
  const rows: any[] = Array.isArray(r) ? r : (r.rows ?? []);
  const out: FreshMint[] = [];
  for (const row of rows) {
    if (evaluatedMints.has(row.mint)) continue;
    const bc = row.metadata?.bondingCurveKey || bondingCurvePda(row.mint);
    out.push({
      mint: row.mint, symbol: row.symbol ?? '?', bondingCurve: bc,
      firstSeenAt: new Date(row.first_seen_at),
      preBuyers: Number(row.pre_buyers ?? 0),
      preBuyUsd: Number(row.pre_buy_usd ?? 0),
    });
  }
  return out;
}

async function fetchCurrentMc(mint: string): Promise<{ mc: number; ath: number } | null> {
  const j: any = await fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`);
  if (!j) return null;
  return { mc: Number(j.usd_market_cap ?? 0), ath: Number(j.ath_market_cap ?? 0) };
}

// =====================================================================
// DISCOVERY LOOP
// =====================================================================
let stats = { discovered: 0, preFiltered: 0, evaluated: 0, passed: 0, opened: 0, closed: { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0 } };

async function discoveryTick(): Promise<void> {
  const fresh = await fetchFreshMints();
  if (fresh.length === 0) return;
  stats.discovered += fresh.length;

  let preFiltered = 0;
  for (const fm of fresh) {
    if (evaluatedMints.has(fm.mint)) continue;
    const ageMin = (Date.now() - fm.firstSeenAt.getTime()) / 60_000;

    // Бесплатный pre-filter через нашу БД: если уже видно что мёртвый — Helius не зовём
    if (fm.preBuyers < PRE_MIN_BUYERS || fm.preBuyUsd < PRE_MIN_BUY_USD) {
      evaluatedMints.add(fm.mint);
      preFiltered++;
      stats.preFiltered++;
      append({ kind: 'eval', mint: fm.mint, symbol: fm.symbol, ageMin: ageMin.toFixed(1),
               pass: false, reason: 'pre_filter',
               pre: { buyers: fm.preBuyers, buy_usd: +fm.preBuyUsd.toFixed(0) } });
      continue;
    }

    let txns: Txn[];
    try {
      txns = await fetchEarlyBcTxns(fm.bondingCurve, 4);
    } catch (err) {
      console.warn(`[eval-err] ${fm.mint.slice(0, 8)} fetch txns: ${err}`);
      continue;
    }
    if (txns.length === 0) {
      // bc может быть некорректным — попробуем PDA
      const pdaBc = bondingCurvePda(fm.mint);
      if (pdaBc !== fm.bondingCurve) {
        try { txns = await fetchEarlyBcTxns(pdaBc, 4); } catch {}
      }
    }
    if (txns.length === 0) {
      // нет данных — отметим как evaluated чтобы не ходить второй раз
      evaluatedMints.add(fm.mint);
      append({ kind: 'eval', mint: fm.mint, symbol: fm.symbol, ageMin, pass: false, reason: 'no_txns' });
      continue;
    }

    const creationTs = txns[0].timestamp * 1000;
    const decisionTs = creationTs + DECISION_AGE_MIN * 60_000;
    const windowStart = creationTs + WINDOW_START_MIN * 60_000;

    const trades: Trade[] = [];
    for (const tx of txns) {
      const ts = tx.timestamp * 1000;
      if (ts > decisionTs) break;
      if (ts < windowStart) continue;
      const tr = parseTrade(tx, fm.mint, fm.bondingCurve);
      if (tr) trades.push(tr);
    }
    const m = computeMetrics(trades);
    const v = evaluate(m);

    stats.evaluated++;
    evaluatedMints.add(fm.mint);
    append({
      kind: 'eval', mint: fm.mint, symbol: fm.symbol, ageMin: ageMin.toFixed(1),
      pass: v.pass, reasons: v.reasons,
      m: { buyers: m.uniqueBuyers, buy: +m.sumBuySol.toFixed(2), sell: +m.sumSellSol.toFixed(2),
           top: +m.topBuyerShare.toFixed(2), bc: +m.bcProgress.toFixed(2) },
    });

    if (!v.pass) continue;
    stats.passed++;

    if (DRY_RUN) {
      console.log(`[DRY] ${fm.mint.slice(0, 8)} $${fm.symbol} would PASS (b=${m.uniqueBuyers}, bc=${(m.bcProgress * 100).toFixed(0)}%)`);
      continue;
    }

    // Open paper trade
    const cur = await fetchCurrentMc(fm.mint);
    if (!cur || cur.mc <= 0) {
      append({ kind: 'eval-skip-open', mint: fm.mint, reason: 'no_mc' });
      continue;
    }
    const ot: OpenTrade = {
      mint: fm.mint, symbol: fm.symbol, entryTs: Date.now(),
      entryMcUsd: cur.mc, entryMetrics: m,
      peakMcUsd: cur.mc, peakPnlPct: 0, trailingArmed: false,
    };
    open.set(fm.mint, ot);
    stats.opened++;
    append({ kind: 'open', ...ot });
    console.log(`[OPEN] ${fm.mint.slice(0, 8)} $${fm.symbol}  mc=$${(cur.mc / 1000).toFixed(1)}k  ` +
                `b=${m.uniqueBuyers}  bc=${(m.bcProgress * 100).toFixed(0)}%`);
  }
}

// =====================================================================
// TRACKER LOOP
// =====================================================================
async function trackerTick(): Promise<void> {
  if (open.size === 0) return;
  const mints = [...open.keys()];
  for (const mint of mints) {
    const ot = open.get(mint);
    if (!ot) continue;
    const cur = await fetchCurrentMc(mint);
    await sleep(120);
    if (!cur || cur.mc <= 0) {
      // если несколько раз подряд недоступно — закроем как NO_DATA через timeout
      const ageH = (Date.now() - ot.entryTs) / 3_600_000;
      if (ageH > TIMEOUT_HOURS) {
        const ct: ClosedTrade = { ...ot, exitTs: Date.now(), exitMcUsd: 0, exitReason: 'NO_DATA', pnlPct: -1, durationMin: ageH * 60 };
        open.delete(mint); closed.push(ct); stats.closed.NO_DATA++;
        append({ kind: 'close', ...ct });
        console.log(`[NO_DATA] ${mint.slice(0, 8)} $${ot.symbol}`);
      }
      continue;
    }
    const x = cur.mc / ot.entryMcUsd;
    const pnlPct = (x - 1) * 100;
    if (cur.mc > ot.peakMcUsd) {
      ot.peakMcUsd = cur.mc;
      ot.peakPnlPct = pnlPct;
      if (x >= TRAIL_TRIGGER_X) ot.trailingArmed = true;
    }

    const ageH = (Date.now() - ot.entryTs) / 3_600_000;
    let exitReason: ExitReason | null = null;
    if (x >= TP_X) exitReason = 'TP';
    else if (x <= SL_X) exitReason = 'SL';
    else if (ot.trailingArmed && cur.mc <= ot.peakMcUsd * (1 - TRAIL_DROP)) exitReason = 'TRAIL';
    else if (ageH >= TIMEOUT_HOURS) exitReason = 'TIMEOUT';

    if (exitReason) {
      const ct: ClosedTrade = { ...ot, exitTs: Date.now(), exitMcUsd: cur.mc, exitReason, pnlPct, durationMin: ageH * 60 };
      open.delete(mint); closed.push(ct); stats.closed[exitReason]++;
      append({ kind: 'close', ...ct });
      const arrow = pnlPct >= 0 ? '+' : '';
      console.log(`[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol}  pnl=${arrow}${pnlPct.toFixed(0)}%  ` +
                  `peak=+${ot.peakPnlPct.toFixed(0)}%  age=${ageH.toFixed(1)}h`);
    }
  }
}

// =====================================================================
// STATS LOOP
// =====================================================================
function statsTick(): void {
  const wins = closed.filter(c => c.pnlPct > 0).length;
  const winRate = closed.length > 0 ? wins / closed.length * 100 : 0;
  const avgPnl = closed.length > 0 ? closed.reduce((s, c) => s + c.pnlPct, 0) / closed.length : 0;
  const sumPnl = closed.reduce((s, c) => s + c.pnlPct, 0);
  const peakAvg = closed.length > 0 ? closed.reduce((s, c) => s + c.peakPnlPct, 0) / closed.length : 0;
  console.log(`\n${'='.repeat(76)}`);
  console.log(`[STATS] discovered=${stats.discovered}  pre_filtered=${stats.preFiltered}  evaluated=${stats.evaluated}  passed=${stats.passed}  opened=${stats.opened}`);
  console.log(`        open=${open.size}  closed=${closed.length}  wins=${wins}  win_rate=${winRate.toFixed(0)}%`);
  console.log(`        avg_pnl=${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%  sum_pnl=${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(1)}%  avg_peak=+${peakAvg.toFixed(1)}%`);
  console.log(`        exits: TP=${stats.closed.TP} SL=${stats.closed.SL} TRAIL=${stats.closed.TRAIL} TIMEOUT=${stats.closed.TIMEOUT} NO_DATA=${stats.closed.NO_DATA}`);
  console.log('='.repeat(76) + '\n');
}

// =====================================================================
// MAIN
// =====================================================================
async function main(): Promise<void> {
  console.log(`=== LIVE PAPER-TRADER ===`);
  console.log(`store=${STORE_PATH}  dry_run=${DRY_RUN}`);
  console.log(`filters: buyers≥${FILTERS.MIN_UNIQUE_BUYERS}, buy_sol≥${FILTERS.MIN_BUY_SOL}, top≤${FILTERS.MAX_TOP_BUYER_SHARE * 100}%, bc∈[${FILTERS.MIN_BC_PROGRESS * 100}..${FILTERS.MAX_BC_PROGRESS * 100}]%`);
  console.log(`window: [${WINDOW_START_MIN}..${DECISION_AGE_MIN}] min  exit: TP=${TP_X}x SL=${SL_X}x TRAIL=-${TRAIL_DROP * 100}% from peak (after ${TRAIL_TRIGGER_X}x)  TIMEOUT=${TIMEOUT_HOURS}h`);

  loadStore();

  // periodic tasks
  let discoveryRunning = false;
  setInterval(async () => {
    if (discoveryRunning) return;
    discoveryRunning = true;
    try { await discoveryTick(); } catch (err) { console.warn(`discovery err: ${err}`); }
    discoveryRunning = false;
  }, DISCOVERY_INTERVAL_MS);

  let trackerRunning = false;
  setInterval(async () => {
    if (trackerRunning) return;
    trackerRunning = true;
    try { await trackerTick(); } catch (err) { console.warn(`tracker err: ${err}`); }
    trackerRunning = false;
  }, TRACK_INTERVAL_MS);

  setInterval(statsTick, STATS_INTERVAL_MS);

  // run immediately once
  await discoveryTick();
  statsTick();

  // graceful exit
  process.on('SIGINT', () => { console.log('\n[shutdown] final stats:'); statsTick(); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\n[shutdown] final stats:'); statsTick(); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
