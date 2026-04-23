/**
 * Retro Validate Runner Detector
 * ===============================
 *
 * Проверяет детектор на ИЗВЕСТНЫХ pump.fun runners: помпанулись бы они
 * через наши 8 фильтров, оценённых в окне [5..30] мин жизни токена?
 *
 * Шаги:
 *   1. Discover: либо --mints "addr1,addr2,..." либо --auto (берём топ
 *      pump.fun токенов из DexScreener boosts — это те, кого реально
 *      продвигали, т.е. доказанные runners).
 *   2. Для каждого mint вычисляем bonding curve PDA, через Helius
 *      постранично тащим EnhancedTransaction'ы на этом адресе до точки
 *      `creationTs + WINDOW_END_MIN`.
 *   3. Парсим каждую txn как buy/sell (SOL flow signer↔bondingCurve +
 *      tokenTransfer mint).
 *   4. Считаем метрики в окне [creationTs + WINDOW_START_MIN ..
 *      creationTs + AGE_AT_DECISION_MIN] (по умолчанию 5..15 мин).
 *   5. Применяем фильтры `runner-detector`'а → вердикт PASS / FAIL
 *   6. Печатаем таблицу + aggregate recall.
 *
 * Usage:
 *   npm run retro:validate -- --mints "mint1,mint2,..."
 *   npm run retro:validate -- --auto --limit 20
 */
import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import { fetch } from 'undici';

const HELIUS_KEY = process.env.HELIUS_API_KEY!;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

// =====================================================================
// CONFIG — МИРРОРИТ runner-detector
// =====================================================================
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const WINDOW_START_MIN = 5;
const AGE_AT_DECISION_MIN = 15;       // оцениваем состояние в этой точке

const MIN_UNIQUE_BUYERS = 20;
const MIN_BUY_SOL = 5;
const MIN_BUY_SELL_RATIO = 1.5;
const MAX_TOP_BUYER_SHARE = 0.30;
const MIN_BC_PROGRESS = 0.25;
const MAX_BC_PROGRESS = 0.90;
const BC_GRADUATION_SOL = 85;

// =====================================================================
// UTILS
// =====================================================================
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SOL_USD_DEFAULT = 200;  // для отображения примерных $ — реального значения тут не нужно

async function fetchJson<T = any>(url: string, retries = 3): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) {
        if (i === retries) console.warn(`  HTTP ${r.status} for ${url.slice(0, 80)}...`);
        return null;
      }
      return await r.json() as T;
    } catch (err) {
      if (i === retries) console.warn(`  fetch err: ${err}`);
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
// DISCOVERY
// =====================================================================
async function discoverRunners(limit: number): Promise<string[]> {
  console.log(`\n[DISCOVERY] fetching top boosted pump.fun tokens from DexScreener...`);
  // 1. token-boosts/top/v1 — те кого реально продвигали, т.е. прошли runner stage
  const boosts: any[] | null = await fetchJson(`https://api.dexscreener.com/token-boosts/top/v1`);
  const mints: string[] = [];
  if (Array.isArray(boosts)) {
    for (const b of boosts) {
      if (b.chainId !== 'solana') continue;
      const addr = String(b.tokenAddress ?? '');
      if (!addr.endsWith('pump')) continue;   // нас интересуют только pump.fun mint'ы
      mints.push(addr);
      if (mints.length >= limit) break;
    }
  }
  // 2. Fallback: trending search
  if (mints.length < limit) {
    const search: any = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=pump`);
    const pairs = Array.isArray(search?.pairs) ? search.pairs : [];
    const seen = new Set(mints);
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue;
      const mint = p.baseToken?.address;
      if (!mint || !mint.endsWith('pump')) continue;
      if (seen.has(mint)) continue;
      if (Number(p.liquidity?.usd ?? 0) < 20000) continue;
      mints.push(mint); seen.add(mint);
      if (mints.length >= limit) break;
    }
  }
  console.log(`[DISCOVERY] found ${mints.length} pump.fun runners`);
  return mints;
}

// =====================================================================
// FETCH EARLY TRANSACTIONS via Helius enhanced API
// =====================================================================
interface Txn {
  signature: string;
  timestamp: number;        // unix sec
  feePayer: string;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
  tokenTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; mint: string; tokenAmount: number }>;
  type?: string;
}

async function heliusTxns(address: string, before?: string): Promise<Txn[]> {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=100${before ? `&before=${before}` : ''}`;
  const data = await fetchJson<Txn[]>(url, 3);
  return Array.isArray(data) ? data : [];
}

/**
 * Returns all transactions ON bondingCurvePda ordered oldest-first,
 * up to `upToTs` (stop when we've gone past the window end).
 * Helius paginates newest-first, so we paginate backwards and stop
 * when oldest-in-page is already older than the cutoff (we've gone deeper
 * than needed).
 */
async function fetchEarlyBcTxns(bcAddr: string, maxPages = 20): Promise<Txn[]> {
  const collected: Txn[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await heliusTxns(bcAddr, cursor);
    if (page.length === 0) break;
    collected.push(...page);
    cursor = page[page.length - 1].signature;
    await sleep(200);  // rate limit courtesy
  }
  // Sort oldest-first
  collected.sort((a, b) => a.timestamp - b.timestamp);
  return collected;
}

// =====================================================================
// PARSE TRADE
// =====================================================================
interface Trade {
  ts: number; signer: string; side: 'buy' | 'sell';
  solAmount: number; tokenAmount: number; signature: string;
}

function parseTrade(tx: Txn, mint: string, bondingCurve: string): Trade | null {
  const signer = tx.feePayer;
  let solDir: 1 | -1 | 0 = 0;
  let solAmount = 0;
  for (const nt of tx.nativeTransfers ?? []) {
    if (nt.fromUserAccount === signer && nt.toUserAccount === bondingCurve) {
      solDir = 1; solAmount = Math.max(solAmount, nt.amount / 1e9);
    } else if (nt.fromUserAccount === bondingCurve && nt.toUserAccount === signer) {
      solDir = -1; solAmount = Math.max(solAmount, nt.amount / 1e9);
    }
  }
  if (solDir === 0 || solAmount <= 0) return null;

  let tokenAmount = 0;
  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.mint !== mint) continue;
    const amt = Number(tt.tokenAmount ?? 0);
    if (amt > tokenAmount) tokenAmount = amt;
  }
  if (tokenAmount <= 0) return null;

  return {
    ts: tx.timestamp * 1000,
    signer, side: solDir > 0 ? 'buy' : 'sell',
    solAmount, tokenAmount, signature: tx.signature,
  };
}

// =====================================================================
// METRICS
// =====================================================================
interface Metrics {
  uniqueBuyers: number; uniqueSellers: number;
  sumBuySol: number; sumSellSol: number;
  topBuyerShare: number; bcProgress: number;
  buyers: Map<string, number>;
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
  return { uniqueBuyers: buyers.size, uniqueSellers: sellers.size,
           sumBuySol: sumBuy, sumSellSol: sumSell, topBuyerShare: topShare, bcProgress, buyers };
}

// =====================================================================
// FILTERS
// =====================================================================
interface Verdict { pass: boolean; reasons: string[]; m: Metrics; }

function evaluate(m: Metrics): Verdict {
  const r: string[] = [];
  if (m.uniqueBuyers < MIN_UNIQUE_BUYERS) r.push(`buyers=${m.uniqueBuyers}<${MIN_UNIQUE_BUYERS}`);
  if (m.sumBuySol < MIN_BUY_SOL) r.push(`buy_sol=${m.sumBuySol.toFixed(2)}<${MIN_BUY_SOL}`);
  if (m.sumSellSol > 0 && m.sumBuySol / m.sumSellSol < MIN_BUY_SELL_RATIO)
    r.push(`b/s=${(m.sumBuySol / m.sumSellSol).toFixed(2)}<${MIN_BUY_SELL_RATIO}`);
  if (m.topBuyerShare > MAX_TOP_BUYER_SHARE)
    r.push(`top=${(m.topBuyerShare * 100).toFixed(0)}%>${MAX_TOP_BUYER_SHARE * 100}%`);
  if (m.bcProgress < MIN_BC_PROGRESS)
    r.push(`bc=${(m.bcProgress * 100).toFixed(0)}%<${MIN_BC_PROGRESS * 100}%`);
  if (m.bcProgress > MAX_BC_PROGRESS)
    r.push(`bc=${(m.bcProgress * 100).toFixed(0)}%>${MAX_BC_PROGRESS * 100}%_graduated`);
  return { pass: r.length === 0, reasons: r, m };
}

// =====================================================================
// MAIN
// =====================================================================
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const has = (k: string) => a.includes(k);
  const sweepRaw = get('--sweep');
  return {
    mints: (get('--mints') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    auto: has('--auto'),
    limit: parseInt(get('--limit') ?? '15', 10),
    ageAtDecision: parseInt(get('--age-min') ?? String(AGE_AT_DECISION_MIN), 10),
    windowStart: parseInt(get('--window-start') ?? String(WINDOW_START_MIN), 10),
    sweep: sweepRaw
      ? sweepRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0)
      : null as number[] | null,
  };
}

function metricsAt(txns: Txn[], mint: string, bc: string, creationTs: number,
                   windowStartMin: number, decisionMin: number): { m: Metrics; trades: number } {
  const windowStart = creationTs + windowStartMin * 60_000;
  const decisionTs = creationTs + decisionMin * 60_000;
  const trades: Trade[] = [];
  for (const tx of txns) {
    const ts = tx.timestamp * 1000;
    if (ts > decisionTs) break;
    if (ts < windowStart) continue;
    const tr = parseTrade(tx, mint, bc);
    if (tr) trades.push(tr);
  }
  return { m: computeMetrics(trades), trades: trades.length };
}

async function validateOne(mint: string, ageAtDecisionMin: number, windowStartMin: number): Promise<Verdict | null> {
  const bc = bondingCurvePda(mint);
  const txns = await fetchEarlyBcTxns(bc, 25);
  if (txns.length === 0) { console.log(`  ! no txns on BC ${bc}`); return null; }
  const creationTs = txns[0].timestamp * 1000;

  const { m, trades } = metricsAt(txns, mint, bc, creationTs, windowStartMin, ageAtDecisionMin);
  const v = evaluate(m);
  console.log(
    `  [${v.pass ? 'PASS' : 'FAIL'}] buyers=${m.uniqueBuyers}  ` +
    `buy_sol=${m.sumBuySol.toFixed(2)} (sell=${m.sumSellSol.toFixed(2)})  ` +
    `top=${(m.topBuyerShare * 100).toFixed(0)}%  bc=${(m.bcProgress * 100).toFixed(0)}%  ` +
    `trades=${trades}  txns_scanned=${txns.length}` +
    (v.reasons.length ? `\n        reasons: ${v.reasons.join(' | ')}` : ''),
  );
  return v;
}

/**
 * Sweep: для каждого mint фетчим транзы один раз, оцениваем метрики
 * в нескольких decision-точках. Помогает найти оптимальное окно входа.
 */
async function sweepOne(mint: string, points: number[], windowStartMin: number)
    : Promise<{ creationTs: number; perPoint: Record<number, Verdict>; txnsCount: number } | null> {
  const bc = bondingCurvePda(mint);
  const txns = await fetchEarlyBcTxns(bc, 25);
  if (txns.length === 0) { console.log(`  ! no txns on BC ${bc}`); return null; }
  const creationTs = txns[0].timestamp * 1000;
  const out: Record<number, Verdict> = {};
  for (const p of points) {
    if (p <= windowStartMin) continue;
    const { m } = metricsAt(txns, mint, bc, creationTs, windowStartMin, p);
    out[p] = evaluate(m);
  }
  // короткая распечатка
  const cells = points.filter(p => p > windowStartMin).map(p => {
    const v = out[p];
    if (v.pass) return `${p}m:PASS(b=${v.m.uniqueBuyers},bc=${(v.m.bcProgress*100).toFixed(0)}%)`;
    const r = v.reasons[0]?.split('=')[0] ?? '?';
    return `${p}m:${r}`;
  });
  console.log(`  ${cells.join('  ')}`);
  return { creationTs, perPoint: out, txnsCount: txns.length };
}

async function main() {
  const args = parseArgs();
  let mints: string[] = args.mints;
  if (mints.length === 0) {
    if (!args.auto) {
      console.log('Usage: --mints "m1,m2,..." OR --auto --limit N');
      process.exit(1);
    }
    mints = await discoverRunners(args.limit);
    if (mints.length === 0) { console.log('No mints discovered.'); process.exit(0); }
  }

  console.log(`\n=== RETRO-VALIDATE RUNNER DETECTOR ===`);
  console.log(`Mints: ${mints.length}`);
  if (args.sweep) {
    console.log(`SWEEP mode — decision points: ${args.sweep.join(', ')} min`);
  } else {
    console.log(`Decision point: ${args.ageAtDecision} min`);
  }
  console.log(`Window start: ${args.windowStart} min`);
  console.log(`Filters: buyers≥${MIN_UNIQUE_BUYERS}, buy_sol≥${MIN_BUY_SOL}, b/s≥${MIN_BUY_SELL_RATIO}, ` +
              `top≤${MAX_TOP_BUYER_SHARE * 100}%, bc∈[${MIN_BC_PROGRESS * 100}..${MAX_BC_PROGRESS * 100}]%`);

  // ===== SWEEP MODE =====
  if (args.sweep) {
    const points = args.sweep;
    const sweepResults: Array<{ mint: string; perPoint: Record<number, Verdict> | null }> = [];
    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i];
      console.log(`\n[${i + 1}/${mints.length}] ${mint}`);
      try {
        const r = await sweepOne(mint, points, args.windowStart);
        sweepResults.push({ mint, perPoint: r?.perPoint ?? null });
      } catch (err) {
        console.log(`  ERROR: ${err}`);
        sweepResults.push({ mint, perPoint: null });
      }
      await sleep(500);
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(`SWEEP RECALL by decision point`);
    console.log('='.repeat(72));
    const evaluated = sweepResults.filter(r => r.perPoint).length;
    console.log(`Evaluated: ${evaluated}/${sweepResults.length}\n`);
    console.log(`  point  PASS  recall  fail_breakdown`);
    for (const p of points) {
      if (p <= args.windowStart) continue;
      let pass = 0; const reasons = new Map<string, number>();
      for (const r of sweepResults) {
        const v = r.perPoint?.[p];
        if (!v) continue;
        if (v.pass) pass++;
        else for (const rsn of v.reasons) {
          const key = rsn.split('=')[0] + (rsn.includes('<') ? '_lo' : rsn.includes('>') ? '_hi' : '');
          reasons.set(key, (reasons.get(key) ?? 0) + 1);
        }
      }
      const breakdown = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, n]) => `${k}=${n}`).join(' ');
      console.log(`  ${String(p).padStart(3)}m   ${String(pass).padStart(3)}   ` +
                  `${(pass / Math.max(evaluated, 1) * 100).toFixed(0).padStart(3)}%   ${breakdown}`);
    }

    // Per-mint best-window
    console.log(`\nPer-mint best PASS window:`);
    for (const r of sweepResults) {
      if (!r.perPoint) { console.log(`  ${r.mint.slice(0, 8)}…  no data`); continue; }
      const passWindows = points.filter(p => r.perPoint![p]?.pass);
      const tag = passWindows.length ? `PASS @ ${passWindows.join(',')} min` : 'never PASS';
      console.log(`  ${r.mint.slice(0, 8)}…  ${tag}`);
    }
    process.exit(0);
  }

  // ===== SINGLE-POINT MODE =====
  const results: Array<{ mint: string; v: Verdict | null }> = [];
  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    console.log(`\n[${i + 1}/${mints.length}] ${mint}`);
    try {
      const v = await validateOne(mint, args.ageAtDecision, args.windowStart);
      results.push({ mint, v });
    } catch (err) {
      console.log(`  ERROR: ${err}`);
      results.push({ mint, v: null });
    }
    await sleep(500);
  }

  const evaluated = results.filter(r => r.v).length;
  const passed = results.filter(r => r.v?.pass).length;
  const failed = results.filter(r => r.v && !r.v.pass).length;

  const reasonCounts = new Map<string, number>();
  for (const r of results) {
    if (!r.v || r.v.pass) continue;
    for (const reason of r.v.reasons) {
      const key = reason.split('=')[0] + (reason.includes('<') ? '_low' : reason.includes('>') ? '_high' : '');
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`SUMMARY`);
  console.log('='.repeat(72));
  console.log(`Evaluated: ${evaluated}/${results.length}  (unresolved: ${results.length - evaluated})`);
  console.log(`PASS: ${passed}  (recall = ${(passed / Math.max(evaluated, 1) * 100).toFixed(0)}%)`);
  console.log(`FAIL: ${failed}`);
  if (reasonCounts.size > 0) {
    console.log(`\nTop FAIL reasons:`);
    for (const [k, n] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(18)} ${n} (${(n / failed * 100).toFixed(0)}%)`);
    }
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
