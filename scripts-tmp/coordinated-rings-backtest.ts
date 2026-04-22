/**
 * Coordinated Buying Rings — backtest гипотезы.
 *
 * Гипотеза: существуют закрытые альфа-группы (Telegram-чаты, инсайдеры,
 * leaked alpha). Когда такая группа решает купить токен, 5+ независимых
 * кошельков заходят в одну монету в окне ≤3 минут. Это видно on-chain
 * как "синхронный rush", который происходит ДО появления токена в trending.
 *
 * Игра против толпы: толпа реагирует на dexscreener trending (5-15 мин лаг).
 * Мы реагируем на pre-trending координацию (секунды-минуты до пампа).
 *
 * Что считаем:
 *   1. Все (mint, window_start) с ≥5 уникальных buyers в ≤180 сек
 *   2. Дедуплицируем пересекающиеся окна
 *   3. Фильтр independence: ≥3 разных funders, нет общих монет за 24ч,
 *      нет farm/scam tags
 *   4. Для каждого: max price в окне +1ч/+3ч/+6ч → return
 *   5. Aggregate: win rate, median, top hits
 *
 * Стоимость: ZERO Helius — только локальный Postgres.
 *
 * Usage:
 *   npm run rings:backtest
 *   npm run rings:backtest -- --min-buyers 4 --window-sec 300
 *   npm run rings:backtest -- --strict   (жёсткие фильтры независимости)
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

interface CliArgs {
  minBuyers: number;
  windowSec: number;
  minSolPerBuy: number;
  strict: boolean;
  showHits: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    minBuyers: 5,
    windowSec: 180,
    minSolPerBuy: 0.5,
    strict: false,
    showHits: 20,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-buyers' && args[i + 1]) { out.minBuyers = Number(args[i + 1]); i++; }
    else if (args[i] === '--window-sec' && args[i + 1]) { out.windowSec = Number(args[i + 1]); i++; }
    else if (args[i] === '--min-sol' && args[i + 1]) { out.minSolPerBuy = Number(args[i + 1]); i++; }
    else if (args[i] === '--show-hits' && args[i + 1]) { out.showHits = Number(args[i + 1]); i++; }
    else if (args[i] === '--strict') { out.strict = true; }
  }
  return out;
}

async function rows<T = any>(q: any): Promise<T[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}

interface Candidate {
  base_mint: string;
  window_start: string;
  window_end: string;
  unique_buyers: number;
  total_usd: number;
  avg_price_usd: number;
  buyers: string[];
}

/**
 * Шаг 1+2: найти окна и дедуплицировать.
 * Берём buys, для каждого окна [t, t+W) смотрим уникальных wallets;
 * жадно дедуплицируем (если новое окно начинается до конца предыдущего на том же
 * mint — пропускаем).
 *
 * Используем USD-фильтр ~$100 как прокси для 0.5 SOL @ $200.
 */
async function findWindows(args: CliArgs): Promise<Candidate[]> {
  const minUsd = args.minSolPerBuy * 200;  // proxy: 1 SOL ≈ $200

  // Pull all buys above threshold
  const all = await rows<{
    base_mint: string;
    wallet: string;
    block_time: string;
    price_usd: number;
    amount_usd: number;
  }>(dsql.raw(`
    SELECT base_mint, wallet, block_time, price_usd, amount_usd
    FROM swaps
    WHERE side = 'buy' AND amount_usd >= ${minUsd}
    ORDER BY base_mint, block_time
  `));

  console.log(`Loaded ${all.length} qualifying buys (≥$${minUsd}, side='buy')`);

  // Group by mint, slide window
  const byMint = new Map<string, typeof all>();
  for (const b of all) {
    if (!byMint.has(b.base_mint)) byMint.set(b.base_mint, []);
    byMint.get(b.base_mint)!.push(b);
  }

  const candidates: Candidate[] = [];

  for (const [mint, buys] of byMint) {
    if (buys.length < args.minBuyers) continue;

    let lastEventEndMs = 0;

    for (let i = 0; i < buys.length; i++) {
      const startMs = new Date(buys[i].block_time).getTime();
      if (startMs < lastEventEndMs) continue;  // dedupe overlap

      const endMs = startMs + args.windowSec * 1000;
      const window = [];
      const seenWallet = new Set<string>();

      for (let j = i; j < buys.length; j++) {
        const tMs = new Date(buys[j].block_time).getTime();
        if (tMs >= endMs) break;
        if (!seenWallet.has(buys[j].wallet)) {
          seenWallet.add(buys[j].wallet);
          window.push(buys[j]);
        }
      }

      if (window.length >= args.minBuyers) {
        const totalUsd = window.reduce((s, x) => s + x.amount_usd, 0);
        const avgPrice = window.reduce((s, x) => s + x.price_usd, 0) / window.length;
        candidates.push({
          base_mint: mint,
          window_start: buys[i].block_time,
          window_end: new Date(endMs).toISOString(),
          unique_buyers: window.length,
          total_usd: totalUsd,
          avg_price_usd: avgPrice,
          buyers: window.map(w => w.wallet),
        });
        lastEventEndMs = endMs;
      }
    }
  }

  return candidates;
}

interface IndependenceResult {
  passed: boolean;
  funders: number;          // distinct funders among buyers
  shared24h_max: number;    // max overlap in mints traded last 24h before event
  farm_tagged: number;      // how many buyers are farm/scam tagged
  reason: string;
}

async function checkIndependence(c: Candidate, strict: boolean): Promise<IndependenceResult> {
  const wallets = c.buyers.map(w => `'${w}'`).join(',');

  // 1. distinct funders
  const fundRow = await rows<{ funders: number }>(dsql.raw(`
    SELECT COUNT(DISTINCT source_wallet)::int AS funders
    FROM money_flows
    WHERE target_wallet IN (${wallets})
      AND asset = 'SOL' AND amount > 0.05
      AND tx_time < '${c.window_start}'
  `));
  const funders = fundRow[0]?.funders ?? 0;

  // 2. farm/scam tags among buyers
  const tagRow = await rows<{ n: number }>(dsql.raw(`
    SELECT COUNT(DISTINCT wallet)::int AS n
    FROM entity_wallets
    WHERE wallet IN (${wallets})
      AND primary_tag IN ('bot_farm_distributor','bot_farm_boss','gas_distributor',
                          'scam_operator','scam_proxy','scam_treasury','scam_payout',
                          'rotation_node','sniper')
  `));
  const farm = tagRow[0]?.n ?? 0;

  // 3. shared mints last 24h (max pairwise overlap)
  // Approximation: count mints touched by >=2 of these buyers in 24h before event
  const sharedRow = await rows<{ mint: string; n: number }>(dsql.raw(`
    SELECT base_mint AS mint, COUNT(DISTINCT wallet)::int AS n
    FROM swaps
    WHERE wallet IN (${wallets})
      AND base_mint != '${c.base_mint}'
      AND block_time BETWEEN ('${c.window_start}'::timestamptz - interval '24 hours')
                         AND '${c.window_start}'::timestamptz
    GROUP BY base_mint
    ORDER BY n DESC
    LIMIT 1
  `));
  const sharedMax = sharedRow[0]?.n ?? 0;

  let passed = true;
  let reason = '';

  // soft mode (default): farm-tagged ≤30%, ≥2 funders, sharedMax<all
  // strict mode: 0 farm-tagged, ≥3 funders, sharedMax≤2
  const farmThr = strict ? 0 : Math.floor(c.unique_buyers * 0.3);
  const fundersMin = strict ? 3 : 2;
  const sharedMaxThr = strict ? 2 : c.unique_buyers - 1;

  if (farm > farmThr) { passed = false; reason = `farm_tagged=${farm}>${farmThr}`; }
  else if (funders < fundersMin) { passed = false; reason = `funders=${funders}<${fundersMin}`; }
  else if (sharedMax > sharedMaxThr) { passed = false; reason = `shared24h=${sharedMax}>${sharedMaxThr}`; }

  return { passed, funders, shared24h_max: sharedMax, farm_tagged: farm, reason };
}

interface PriceTrack {
  entry_price: number;
  max_1h: number;
  max_3h: number;
  max_6h: number;
  ret_1h: number;
  ret_3h: number;
  ret_6h: number;
  /** any subsequent swaps observed at all */
  has_data: boolean;
  n_followups: number;
}

async function trackPrice(c: Candidate): Promise<PriceTrack> {
  const r = await rows<{ horizon: string; max_p: number; n: number }>(dsql.raw(`
    WITH base AS (
      SELECT '${c.window_start}'::timestamptz AS t0, '${c.base_mint}'::text AS mint
    ),
    s AS (
      SELECT block_time, price_usd
      FROM swaps, base
      WHERE base_mint = base.mint AND block_time > base.t0
    )
    SELECT '1h' AS horizon, COALESCE(MAX(price_usd),0)::float AS max_p, COUNT(*)::int AS n
      FROM s, base WHERE block_time <= base.t0 + interval '1 hour'
    UNION ALL
    SELECT '3h', COALESCE(MAX(price_usd),0)::float, COUNT(*)::int
      FROM s, base WHERE block_time <= base.t0 + interval '3 hour'
    UNION ALL
    SELECT '6h', COALESCE(MAX(price_usd),0)::float, COUNT(*)::int
      FROM s, base WHERE block_time <= base.t0 + interval '6 hour'
  `));

  const m = new Map<string, { max_p: number; n: number }>();
  for (const x of r) m.set(x.horizon, { max_p: x.max_p, n: x.n });
  const m1 = m.get('1h') ?? { max_p: 0, n: 0 };
  const m3 = m.get('3h') ?? { max_p: 0, n: 0 };
  const m6 = m.get('6h') ?? { max_p: 0, n: 0 };

  const entry = c.avg_price_usd;
  const has = m6.n > 0;

  return {
    entry_price: entry,
    max_1h: m1.max_p,
    max_3h: m3.max_p,
    max_6h: m6.max_p,
    ret_1h: m1.max_p > 0 ? (m1.max_p / entry - 1) * 100 : 0,
    ret_3h: m3.max_p > 0 ? (m3.max_p / entry - 1) * 100 : 0,
    ret_6h: m6.max_p > 0 ? (m6.max_p / entry - 1) * 100 : 0,
    has_data: has,
    n_followups: m6.n,
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function main() {
  const args = parseArgs();
  console.log(`\n=== Coordinated Buying Rings — backtest ===`);
  console.log(`Params: min_buyers=${args.minBuyers}, window=${args.windowSec}s, min_sol_per_buy=${args.minSolPerBuy}, strict=${args.strict}\n`);

  // Step 1+2: find windows
  console.log(`STEP 1: finding sync-buy windows...`);
  const candidates = await findWindows(args);
  console.log(`  Found ${candidates.length} candidate windows\n`);

  if (candidates.length === 0) {
    console.log(`No candidates. Try lowering --min-buyers or --min-sol or --window-sec.`);
    process.exit(0);
  }

  // Step 3: independence filter
  console.log(`STEP 2: independence filter (${args.strict ? 'strict' : 'soft'})...`);
  const passed: Array<Candidate & { ind: IndependenceResult; price: PriceTrack }> = [];
  let i = 0;
  for (const c of candidates) {
    i++;
    if (i % 50 === 0) console.log(`  ...${i}/${candidates.length}`);
    const ind = await checkIndependence(c, args.strict);
    if (!ind.passed) continue;
    const price = await trackPrice(c);
    passed.push({ ...c, ind, price });
  }
  console.log(`  ${passed.length} candidates passed independence filter\n`);

  if (passed.length === 0) {
    console.log(`No clean rings detected. Likely all coordinated buys we see are bot farms.`);
    console.log(`Try with --strict off (default) and lower --min-buyers.`);
    process.exit(0);
  }

  // Step 4: aggregate
  console.log(`STEP 3: PnL aggregation`);
  console.log(`${'='.repeat(72)}`);
  const tradable = passed.filter(p => p.price.has_data);
  console.log(`Total events: ${passed.length}`);
  console.log(`With price-followup data: ${tradable.length}`);
  if (tradable.length === 0) {
    console.log(`No followup price data — events too recent or mints not in our swaps table.`);
    process.exit(0);
  }

  for (const horizon of [1, 3, 6] as const) {
    const key = `ret_${horizon}h` as const;
    const rets = tradable.map(p => p.price[key]);
    const wins10 = rets.filter(r => r >= 10).length;
    const wins25 = rets.filter(r => r >= 25).length;
    const wins50 = rets.filter(r => r >= 50).length;
    const losses20 = rets.filter(r => r <= -20).length;
    console.log(
      `  +${horizon}h:  median=${median(rets).toFixed(1)}%  ` +
      `>+10%=${wins10}/${tradable.length} (${Math.round(wins10*100/tradable.length)}%)  ` +
      `>+25%=${wins25}  >+50%=${wins50}  <-20%=${losses20}`,
    );
  }

  // Step 5: top hits
  const topByRet = [...tradable].sort((a, b) => b.price.ret_3h - a.price.ret_3h).slice(0, args.showHits);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`TOP-${topByRet.length} HITS by 3h return:`);
  console.log('='.repeat(72));
  for (const p of topByRet) {
    console.log(`\n  mint: ${p.base_mint}`);
    console.log(`  https://dexscreener.com/solana/${p.base_mint}`);
    console.log(`  event: ${p.window_start.slice(0, 19)}  buyers=${p.unique_buyers}  vol=$${p.total_usd.toFixed(0)}`);
    console.log(`  funders=${p.ind.funders}  shared24h=${p.ind.shared24h_max}  farm_tagged=${p.ind.farm_tagged}`);
    console.log(`  entry=$${p.price.entry_price.toExponential(3)}  ret_1h=${p.price.ret_1h.toFixed(1)}%  ret_3h=${p.price.ret_3h.toFixed(1)}%  ret_6h=${p.price.ret_6h.toFixed(1)}%`);
    console.log(`  buyers (top-5):`);
    for (const w of p.buyers.slice(0, 5)) {
      console.log(`    ${w}  https://solscan.io/account/${w}`);
    }
  }

  // Worst losses for sanity
  const losses = [...tradable].filter(p => p.price.ret_3h < 0)
    .sort((a, b) => a.price.ret_3h - b.price.ret_3h).slice(0, 5);
  if (losses.length > 0) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`WORST LOSSES (3h return):`);
    console.log('='.repeat(72));
    for (const p of losses) {
      console.log(`  ${p.base_mint}  buyers=${p.unique_buyers}  ret_3h=${p.price.ret_3h.toFixed(1)}%`);
    }
  }

  console.log(`\n=== ВЕРДИКТ ===`);
  const med3h = median(tradable.map(p => p.price.ret_3h));
  const winRate = tradable.filter(p => p.price.ret_3h >= 10).length / tradable.length;
  if (med3h >= 15 && winRate >= 0.5) {
    console.log(`✓ STRONG SIGNAL — median +${med3h.toFixed(1)}% / win-rate ${(winRate*100).toFixed(0)}% — стоит превращать в realtime детектор`);
  } else if (med3h >= 5 && winRate >= 0.4) {
    console.log(`~ WEAK SIGNAL — median +${med3h.toFixed(1)}% / win-rate ${(winRate*100).toFixed(0)}% — нужно уточнять фильтры`);
  } else {
    console.log(`✗ NO SIGNAL — median ${med3h.toFixed(1)}% / win-rate ${(winRate*100).toFixed(0)}% — паттерн не работает в нашей выборке`);
  }
  console.log();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
