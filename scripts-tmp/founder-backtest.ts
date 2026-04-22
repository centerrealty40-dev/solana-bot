/**
 * Backtest «Founder Frontrunner» strategy.
 *
 * Гипотеза: серийные scam-операторы (treasury/payout/operator wallets) запускают
 * новые токены регулярно и почти всегда устраивают сибил-pump. Если успеть купить
 * в первые 30 секунд после launch — мы катаемся на их же pump'е.
 *
 * Эта стратегия использует НАШУ уникальную базу wallet_tags + money_flows.
 * Конкуренты не могут её повторить, потому что не строят историю операторов.
 *
 * Метод:
 *   1. Достаём из БД пул "потенциальных launcher'ов":
 *      - tagged scam_treasury / scam_payout / scam_operator / scam_proxy
 *      - + кошельки получавшие SOL от них (downstream funded launchers)
 *   2. Для каждого через Helius находим события TOKEN_MINT / CREATE_POOL
 *      за последние LOOKBACK_DAYS дней
 *   3. Для каждого launched mint:
 *      - находим pool через Dexscreener
 *      - забираем OHLCV из GeckoTerminal вокруг launch'а
 *      - симулируем трейд: BUY +30s после launch
 *      - exit: TP +50% / SL -30% / timeout 5 минут
 *   4. Агрегируем hit rate, avg P&L, total samples
 *
 * Verdict: если hit_rate >= 40% AND avg_pnl > 0 → стратегия рабочая.
 */

import 'dotenv/config';
import pg from 'pg';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing in .env'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL missing in .env'); process.exit(1); }

// === Настройки бэктеста ===
const FOUNDER_TAGS = ['scam_treasury', 'scam_payout', 'scam_operator', 'scam_proxy'];
const LOOKBACK_DAYS = 30;
const MAX_LAUNCHERS = 80;             // hard cap чтобы не сжечь Helius credits
const MAX_HISTORY_PAGES = 5;          // 500 txs max per launcher
const MIN_LIQUIDITY_USD = 500;        // отфильтровать совсем мусор
const ENTRY_DELAY_SEC = 30;
const TP = 1.5;                       // +50%
const SL = 0.7;                       // -30%
const TIMEOUT_MIN = 5;
const HOLD_AFTER_LAUNCH_HOURS = 4;    // глубина OHLCV выборки
const GECKO_PAUSE_MS = 700;

// === Типы ===
interface Founder { wallet: string; source: 'tagged' | 'downstream'; tag?: string; }
interface Launch { launcher: string; mint: string; sig: string; createdAtMs: number; }
interface Candle { ts: number; open: number; high: number; low: number; close: number; volUsd: number; }
interface SimResult {
  mint: string;
  launcher: string;
  createdAtMs: number;
  outcome: 'TP' | 'SL' | 'TIMEOUT' | 'DEAD' | 'NO_POOL' | 'NO_DATA' | 'TOO_LATE';
  pnlPct: number;
  peakX: number;
  liquidityUsdAtCheck?: number;
}

// === Утилиты ===
async function loadFounders(): Promise<Founder[]> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const founders = new Map<string, Founder>();
  try {
    const tagged = await pool.query<{ wallet: string; tag: string }>(
      `SELECT DISTINCT wallet, tag FROM wallet_tags WHERE tag = ANY($1::text[])`,
      [FOUNDER_TAGS],
    );
    for (const r of tagged.rows) founders.set(r.wallet, { wallet: r.wallet, source: 'tagged', tag: r.tag });

    // downstream: те, кто получали SOL от tagged за последний месяц (кандидаты в LP-owners)
    const downstream = await pool.query<{ target_wallet: string }>(
      `SELECT DISTINCT mf.target_wallet
         FROM money_flows mf
         JOIN wallet_tags wt ON mf.source_wallet = wt.wallet
        WHERE wt.tag = ANY($1::text[])
          AND mf.asset = 'SOL'
          AND mf.amount BETWEEN 0.005 AND 5         -- газ-подобные суммы
          AND mf.tx_time > now() - ($2 || ' days')::interval`,
      [FOUNDER_TAGS, String(LOOKBACK_DAYS + 7)],
    );
    for (const r of downstream.rows) {
      if (!founders.has(r.target_wallet)) {
        founders.set(r.target_wallet, { wallet: r.target_wallet, source: 'downstream' });
      }
    }
    return [...founders.values()];
  } finally {
    await pool.end();
  }
}

async function fetchHeliusTxPage(wallet: string, before?: string): Promise<any[]> {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY!);
  u.searchParams.set('limit', '100');
  if (before) u.searchParams.set('before', before);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u.toString());
      if (r.status === 429) { await new Promise(res => setTimeout(res, 1500)); continue; }
      if (!r.ok) {
        if (attempt === 2) console.error(`helius ${wallet.slice(0,8)} status=${r.status}`);
        await new Promise(res => setTimeout(res, 600));
        continue;
      }
      return await r.json() as any[];
    } catch { await new Promise(res => setTimeout(res, 600)); }
  }
  return [];
}

function extractMintFromTx(tx: any): string | null {
  // Helius enhanced может класть mint в разные места
  if (tx.events?.tokenMint?.mint) return tx.events.tokenMint.mint;
  if (tx.events?.token?.mint) return tx.events.token.mint;
  // tokenTransfers — первый non-WSOL/USDC transfer
  for (const t of tx.tokenTransfers ?? []) {
    if (!t.mint) continue;
    if (t.mint === 'So11111111111111111111111111111111111111112') continue;
    if (t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') continue;
    return t.mint;
  }
  return null;
}

async function findLaunches(f: Founder, sinceMs: number): Promise<Launch[]> {
  const launches: Launch[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const txs = await fetchHeliusTxPage(f.wallet, before);
    if (!txs.length) break;
    for (const tx of txs) {
      const tsMs = (tx.timestamp ?? 0) * 1000;
      if (tsMs < sinceMs) return launches;
      const isLaunch = tx.type === 'TOKEN_MINT' || tx.type === 'CREATE_POOL';
      if (!isLaunch) continue;
      const mint = extractMintFromTx(tx);
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      launches.push({ launcher: f.wallet, mint, sig: tx.signature, createdAtMs: tsMs });
    }
    before = txs[txs.length - 1]?.signature;
    if (txs.length < 100) break;
  }
  return launches;
}

interface DexPair { pairAddress: string; liquidity?: { usd?: number }; baseToken: { address: string }; }

async function findPoolForMint(mint: string): Promise<{ pool: string; liq: number } | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) return null;
    const j = await r.json() as any;
    const pairs: DexPair[] = (j.pairs ?? []).filter((p: any) => p.chainId === 'solana');
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (!pairs.length) return null;
    return { pool: pairs[0].pairAddress, liq: pairs[0].liquidity?.usd ?? 0 };
  } catch { return null; }
}

async function fetchOhlcvPage(pool: string, beforeTsSec?: number): Promise<Candle[]> {
  const u = new URL(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute`);
  u.searchParams.set('aggregate', '1');
  u.searchParams.set('limit', '1000');
  if (beforeTsSec) u.searchParams.set('before_timestamp', String(beforeTsSec));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
      if (r.status === 429) { await new Promise(res => setTimeout(res, 2500)); continue; }
      if (!r.ok) { await new Promise(res => setTimeout(res, 700)); continue; }
      const j = await r.json() as any;
      const list: any[] = j?.data?.attributes?.ohlcv_list ?? [];
      return list.map(([ts, open, high, low, close, volUsd]) => ({ ts, open, high, low, close, volUsd }));
    } catch { await new Promise(res => setTimeout(res, 700)); }
  }
  return [];
}

async function fetchCandlesAround(pool: string, fromSec: number, toSec: number): Promise<Candle[]> {
  const all = new Map<number, Candle>();
  let before: number | undefined = toSec + 60;
  for (let page = 0; page < 6; page++) {
    const candles = await fetchOhlcvPage(pool, before);
    if (!candles.length) break;
    let minOfPage = Number.MAX_SAFE_INTEGER;
    for (const c of candles) {
      if (c.ts > toSec) continue;
      if (c.ts < fromSec) continue;
      all.set(c.ts, c);
      minOfPage = Math.min(minOfPage, c.ts);
    }
    const pageMin = Math.min(...candles.map(c => c.ts));
    if (pageMin <= fromSec) break;
    before = pageMin;
    if (candles.length < 1000) break;
    await new Promise(res => setTimeout(res, GECKO_PAUSE_MS));
  }
  return [...all.values()].sort((a, b) => a.ts - b.ts);
}

function simulate(launchAtSec: number, candles: Candle[]): SimResult['outcome'] extends infer T ? { outcome: SimResult['outcome']; pnlPct: number; peakX: number } : never {
  if (!candles.length) return { outcome: 'NO_DATA', pnlPct: 0, peakX: 0 } as any;

  const entryTs = launchAtSec + ENTRY_DELAY_SEC;
  // Найти первую свечу >= entry time (в первые 5 мин после entry)
  let entryIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].ts >= entryTs) { entryIdx = i; break; }
  }
  if (entryIdx < 0) return { outcome: 'TOO_LATE', pnlPct: 0, peakX: 0 } as any;

  const entryPrice = (candles[entryIdx].open + candles[entryIdx].close) / 2;
  if (entryPrice <= 0) return { outcome: 'NO_DATA', pnlPct: 0, peakX: 0 } as any;

  const tpPx = entryPrice * TP;
  const slPx = entryPrice * SL;
  let peakX = 1;

  const horizonTs = candles[entryIdx].ts + TIMEOUT_MIN * 60;
  for (let j = entryIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    if (c.ts > horizonTs) break;
    peakX = Math.max(peakX, c.high / entryPrice);
    if (c.high >= tpPx) return { outcome: 'TP', pnlPct: ((tpPx - entryPrice) / entryPrice) * 100, peakX } as any;
    if (c.low <= slPx) return { outcome: 'SL', pnlPct: ((slPx - entryPrice) / entryPrice) * 100, peakX } as any;
  }
  // Timeout: продаём по close последней свечи в окне
  let lastIdx = entryIdx;
  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].ts > horizonTs) break;
    lastIdx = j;
  }
  const exitPrice = candles[lastIdx].close;
  return { outcome: 'TIMEOUT', pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100, peakX } as any;
}

async function main() {
  console.log(`\n=== Founder Frontrunner Backtest ===`);
  console.log(`Lookback: ${LOOKBACK_DAYS} days, max launchers: ${MAX_LAUNCHERS}`);
  console.log(`Trade rules: entry +${ENTRY_DELAY_SEC}s, TP +${(TP-1)*100}%, SL ${(SL-1)*100}%, timeout ${TIMEOUT_MIN}min\n`);

  console.log('STAGE 1: load founder pool from DB...');
  const allFounders = await loadFounders();
  const tagged = allFounders.filter(f => f.source === 'tagged').length;
  const downstream = allFounders.filter(f => f.source === 'downstream').length;
  console.log(`  total: ${allFounders.length} (tagged: ${tagged}, downstream: ${downstream})`);

  const founders = allFounders.slice(0, MAX_LAUNCHERS);
  if (allFounders.length > MAX_LAUNCHERS) console.log(`  capped to ${MAX_LAUNCHERS} for backtest`);

  console.log(`\nSTAGE 2: scan Helius history per founder for TOKEN_MINT/CREATE_POOL events...`);
  const sinceMs = Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000;
  const allLaunches: Launch[] = [];
  for (let i = 0; i < founders.length; i++) {
    const f = founders[i];
    process.stderr.write(`  [${i+1}/${founders.length}] ${f.wallet.slice(0,8)} (${f.source}${f.tag ? ':'+f.tag : ''}) `);
    const launches = await findLaunches(f, sinceMs);
    process.stderr.write(`launches=${launches.length}\n`);
    allLaunches.push(...launches);
  }
  // dedup by mint (несколько founder'ов могли быть в одном запуске)
  const dedup = new Map<string, Launch>();
  for (const l of allLaunches) {
    const ex = dedup.get(l.mint);
    if (!ex || l.createdAtMs < ex.createdAtMs) dedup.set(l.mint, l);
  }
  const launches = [...dedup.values()];
  console.log(`  total launches found: ${allLaunches.length} (unique mints: ${launches.length})`);

  if (launches.length === 0) {
    console.log(`\n=== ВЕРДИКТ ===`);
    console.log(`✗ Не нашли ни одного TOKEN_MINT/CREATE_POOL события у наших операторов за ${LOOKBACK_DAYS} дней.`);
    console.log(`  Возможно: (1) операторы не сами создают токены, а только сибилят; или (2) Helius не классифицирует их события как TOKEN_MINT/CREATE_POOL.`);
    console.log(`  Следующий шаг: попробовать другую сигнатуру launch'а — например искать по money_flows того, кто первый купил после mint creation.`);
    return;
  }

  console.log(`\nSTAGE 3: simulate trades on each launch...`);
  const results: SimResult[] = [];
  for (let i = 0; i < launches.length; i++) {
    const L = launches[i];
    process.stderr.write(`  [${i+1}/${launches.length}] ${L.mint.slice(0,8)}… `);
    const poolInfo = await findPoolForMint(L.mint);
    if (!poolInfo) {
      results.push({ mint: L.mint, launcher: L.launcher, createdAtMs: L.createdAtMs, outcome: 'DEAD', pnlPct: 0, peakX: 0 });
      process.stderr.write(`DEAD (no pool on dexscreener)\n`);
      continue;
    }
    if (poolInfo.liq < MIN_LIQUIDITY_USD) {
      results.push({ mint: L.mint, launcher: L.launcher, createdAtMs: L.createdAtMs, outcome: 'DEAD', pnlPct: 0, peakX: 0, liquidityUsdAtCheck: poolInfo.liq });
      process.stderr.write(`DEAD (liq=$${poolInfo.liq.toFixed(0)} < $${MIN_LIQUIDITY_USD})\n`);
      continue;
    }
    const launchSec = Math.floor(L.createdAtMs / 1000);
    const candles = await fetchCandlesAround(poolInfo.pool, launchSec - 60, launchSec + HOLD_AFTER_LAUNCH_HOURS * 3600);
    const sim = simulate(launchSec, candles);
    results.push({
      mint: L.mint, launcher: L.launcher, createdAtMs: L.createdAtMs,
      outcome: sim.outcome, pnlPct: sim.pnlPct, peakX: sim.peakX,
      liquidityUsdAtCheck: poolInfo.liq,
    });
    process.stderr.write(`${sim.outcome} pnl=${sim.pnlPct.toFixed(1)}% peakX=${sim.peakX.toFixed(2)}\n`);
    await new Promise(res => setTimeout(res, GECKO_PAUSE_MS));
  }

  console.log(`\n========== AGGREGATE ==========`);
  const total = results.length;
  const dead = results.filter(r => r.outcome === 'DEAD').length;
  const noData = results.filter(r => r.outcome === 'NO_DATA' || r.outcome === 'NO_POOL' || r.outcome === 'TOO_LATE').length;
  const tradable = results.filter(r => ['TP', 'SL', 'TIMEOUT'].includes(r.outcome));
  const tpCnt = tradable.filter(r => r.outcome === 'TP').length;
  const slCnt = tradable.filter(r => r.outcome === 'SL').length;
  const toCnt = tradable.filter(r => r.outcome === 'TIMEOUT').length;
  const wins = tradable.filter(r => r.pnlPct > 0).length;
  const winRate = tradable.length ? (wins / tradable.length) * 100 : 0;
  const avgPnl = tradable.length ? tradable.reduce((s, r) => s + r.pnlPct, 0) / tradable.length : 0;
  const sumPnl = tradable.reduce((s, r) => s + r.pnlPct, 0);
  const peakXs = tradable.map(r => r.peakX).sort((a, b) => b - a);
  const medPeakX = peakXs.length ? peakXs[Math.floor(peakXs.length / 2)] : 0;

  console.log(`Launches scanned:    ${total}`);
  console.log(`  DEAD (no/low liq): ${dead}  (${((dead/total)*100).toFixed(0)}%)`);
  console.log(`  NO_DATA:           ${noData}`);
  console.log(`  Tradable:          ${tradable.length}`);
  console.log(`    TP:      ${tpCnt}`);
  console.log(`    SL:      ${slCnt}`);
  console.log(`    TIMEOUT: ${toCnt}`);
  console.log(`Win rate:        ${winRate.toFixed(0)}% (${wins}/${tradable.length})`);
  console.log(`Avg P&L:         ${avgPnl.toFixed(1)}%  per trade`);
  console.log(`Sum P&L:         ${sumPnl.toFixed(0)}%  (на $100/трейд = $${sumPnl.toFixed(0)})`);
  console.log(`Median peak X:   ${medPeakX.toFixed(2)}x  (макс. куда цена доходила в окне до exit)`);

  // Топ-5 победителей и проигрышей
  const sorted = [...tradable].sort((a, b) => b.pnlPct - a.pnlPct);
  console.log(`\nTop 5 wins:`);
  for (const r of sorted.slice(0, 5)) {
    console.log(`  ${r.mint.slice(0,8)}…  +${r.pnlPct.toFixed(1)}%  peakX=${r.peakX.toFixed(2)}  launcher=${r.launcher.slice(0,8)}…  https://dexscreener.com/solana/${r.mint}`);
  }
  console.log(`\nTop 5 losses:`);
  for (const r of sorted.slice(-5).reverse()) {
    console.log(`  ${r.mint.slice(0,8)}…  ${r.pnlPct.toFixed(1)}%  peakX=${r.peakX.toFixed(2)}  launcher=${r.launcher.slice(0,8)}…`);
  }

  console.log(`\n=== ВЕРДИКТ ===`);
  if (tradable.length < 10) {
    console.log(`~ Слишком мало tradable выборки (${tradable.length}) — нужно расширить founder pool или увеличить lookback.`);
  } else if (winRate >= 50 && avgPnl >= 5) {
    console.log(`✓✓ СИЛЬНЫЙ EDGE — стратегия работает, идём в production.`);
  } else if (winRate >= 40 && avgPnl > 0) {
    console.log(`✓ Edge есть. Можно идти в production с осторожностью + улучшать exit.`);
  } else if (winRate >= 30) {
    console.log(`~ Edge слабый/неустойчивый. Возможно стоит ужесточить фильтр founder'ов или поменять exit-правила.`);
  } else {
    console.log(`✗ Edge'а нет. Стратегия "купить за всеми scam-операторами" не работает в чистом виде.`);
    console.log(`  Возможные причины: (1) launchers ≠ pump-creators (наши operators только сибилят); (2) большинство токенов реально rug в первые минуты; (3) задержка 30s слишком большая.`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
