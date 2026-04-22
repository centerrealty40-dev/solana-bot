/**
 * Human Trader Discovery & Dossier
 *
 * Цель: найти кошельки которые торгуют как ЧЕЛОВЕК (не бот) и зарабатывают.
 * Изучить их паттерны → возможно извлечь воспроизводимые сигналы.
 *
 * Анализирует ТОЛЬКО данные из нашей БД (таблица swaps), без внешних API.
 * Работает по нашим watchlist-кошелькам — те что мы уже отобрали как потенциально
 * интересные через H8 (rotation network).
 *
 * Pipeline:
 *   STAGE 1 — кандидаты по жёсткому SQL-фильтру:
 *     - LOOKBACK_DAYS дней истории
 *     - >= MIN_SWAPS трейдов всего (с учётом возможных выходных)
 *     - <= MAX_SWAPS (отсечь явных HF-ботов)
 *     - >= MIN_UNIQUE_TOKENS разных токенов (не «обнимается с одной монеткой»)
 *     - >= MIN_PNL_USD оценка net P&L (sells - buys по объёму)
 *
 *   STAGE 2 — humanness scoring для каждого кандидата:
 *     + Большая дисперсия интервалов между swap'ами (низкая cv = bot)
 *     + Есть длинные перерывы >24/72h (человек спит, берёт выходной)
 *     + Есть «ночной провал» в почасовой гистограмме
 *     + Доля «круглых» сумм ($100/500/1000) выше шума
 *     + Активные дни < 80% от lookback (есть пропущенные дни)
 *     Score = 0..5; чем выше — тем больше похож на человека
 *
 *   STAGE 3 — досье на топ-K финалистов:
 *     - Топ-5 успешных и проигрышных трейдов (по net P&L на токене)
 *     - Топ-10 любимых токенов
 *     - Распределение holding-time
 *     - Гистограмма активных часов → определяем timezone
 *     - Solscan / Photon / GMGN ссылки для ручного ревью
 */

import 'dotenv/config';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

// === Настройки ===
const LOOKBACK_DAYS         = 30;
const MIN_SWAPS             = 30;        // 1+ swap/day average, с поправкой на выходные
const MAX_SWAPS             = 3000;      // 100/day cap — выше скорее всего bot
const MIN_UNIQUE_TOKENS     = 5;
const MIN_PNL_USD           = 3000;      // консервативно — net buy/sell volume diff
const MIN_AVG_TRADE_USD     = 50;        // отсечь dust
const TOP_K_FINALISTS       = 10;

interface Candidate {
  wallet: string;
  swapCount: number;
  uniqueTokens: number;
  pnlProxy: number;       // sum(sells) - sum(buys) в USD (по нашим данным)
  avgTradeUsd: number;
  totalVolumeUsd: number;
  activeDays: number;
  firstSwapAt: Date;
  lastSwapAt: Date;
}

interface SwapRow {
  ts: Date;
  side: 'buy' | 'sell';
  amountUsd: number;
  baseMint: string;
}

interface HumanScore {
  intervalCoeffVar: number;
  longBreaksCount: number;
  hasNightDip: boolean;
  roundSumRatio: number;
  activeDaysRatio: number;
  score: number;
}

interface TokenPnl { mint: string; buys: number; sells: number; netPnl: number; tradeCount: number; }

async function loadCandidates(client: pg.PoolClient): Promise<Candidate[]> {
  const sql = `
    WITH stats AS (
      SELECT
        wallet,
        COUNT(*)                                                         AS swap_count,
        COUNT(DISTINCT base_mint)                                        AS unique_tokens,
        SUM(CASE WHEN side='sell' THEN amount_usd ELSE -amount_usd END)  AS pnl_proxy,
        AVG(amount_usd)                                                  AS avg_trade_usd,
        SUM(amount_usd)                                                  AS total_volume_usd,
        COUNT(DISTINCT date_trunc('day', block_time))                    AS active_days,
        MIN(block_time)                                                  AS first_swap_at,
        MAX(block_time)                                                  AS last_swap_at
      FROM swaps
      WHERE block_time > now() - ($1 || ' days')::interval
        AND amount_usd > 0
      GROUP BY wallet
    )
    SELECT * FROM stats
    WHERE swap_count    BETWEEN $2 AND $3
      AND unique_tokens >= $4
      AND pnl_proxy     >= $5
      AND avg_trade_usd >= $6
    ORDER BY pnl_proxy DESC;
  `;
  const res = await client.query(sql, [
    String(LOOKBACK_DAYS), MIN_SWAPS, MAX_SWAPS, MIN_UNIQUE_TOKENS, MIN_PNL_USD, MIN_AVG_TRADE_USD,
  ]);
  return res.rows.map(r => ({
    wallet: r.wallet,
    swapCount: Number(r.swap_count),
    uniqueTokens: Number(r.unique_tokens),
    pnlProxy: Number(r.pnl_proxy),
    avgTradeUsd: Number(r.avg_trade_usd),
    totalVolumeUsd: Number(r.total_volume_usd),
    activeDays: Number(r.active_days),
    firstSwapAt: new Date(r.first_swap_at),
    lastSwapAt: new Date(r.last_swap_at),
  }));
}

async function loadSwaps(client: pg.PoolClient, wallet: string): Promise<SwapRow[]> {
  const sql = `
    SELECT block_time AS ts, side, amount_usd, base_mint
    FROM swaps
    WHERE wallet = $1
      AND block_time > now() - ($2 || ' days')::interval
    ORDER BY block_time ASC
  `;
  const res = await client.query(sql, [wallet, String(LOOKBACK_DAYS)]);
  return res.rows.map(r => ({
    ts: new Date(r.ts),
    side: r.side === 'sell' ? 'sell' : 'buy',
    amountUsd: Number(r.amount_usd),
    baseMint: r.base_mint,
  }));
}

function computeHumanScore(swaps: SwapRow[], cand: Candidate): HumanScore {
  // 1. Intervals between swaps
  const intervals: number[] = [];
  for (let i = 1; i < swaps.length; i++) {
    intervals.push((swaps[i].ts.getTime() - swaps[i - 1].ts.getTime()) / 1000);
  }
  const meanIv = intervals.reduce((s, x) => s + x, 0) / Math.max(1, intervals.length);
  const varIv  = intervals.reduce((s, x) => s + (x - meanIv) ** 2, 0) / Math.max(1, intervals.length);
  const stdIv  = Math.sqrt(varIv);
  const coeffVar = meanIv > 0 ? stdIv / meanIv : 0;  // bot ~0.5-1.5, человек > 2.0

  // 2. Long breaks (> 72 часа = >3 дня без активности)
  const longBreaksCount = intervals.filter(x => x > 72 * 3600).length;

  // 3. Night dip — есть ли «провал» в почасовой гистограмме
  const hourHist = new Array(24).fill(0);
  for (const s of swaps) hourHist[s.ts.getUTCHours()]++;
  const totalHourly = hourHist.reduce((a, b) => a + b, 0);
  // самый «тихий» 6-часовой блок vs самый шумный
  const blocks = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += hourHist[(h + k) % 24];
    blocks[h] = sum;
  }
  const minBlock = Math.min(...blocks);
  const maxBlock = Math.max(...blocks);
  const hasNightDip = totalHourly > 20 && (minBlock / Math.max(1, maxBlock)) < 0.25;

  // 4. Round sums ratio
  const roundCount = swaps.filter(s => {
    const u = s.amountUsd;
    if (u <= 0) return false;
    return [50, 100, 200, 250, 500, 1000, 2000, 5000].some(r => Math.abs(u - r) < r * 0.02);
  }).length;
  const roundSumRatio = swaps.length ? roundCount / swaps.length : 0;

  // 5. Active days ratio — < 0.8 = есть «выходные»
  const activeDaysRatio = cand.activeDays / LOOKBACK_DAYS;

  // === Scoring (0..5) ===
  let score = 0;
  if (coeffVar > 2.0)               score++;
  if (longBreaksCount >= 1)         score++;
  if (hasNightDip)                  score++;
  if (roundSumRatio > 0.05)         score++;
  if (activeDaysRatio < 0.8)        score++;

  return { intervalCoeffVar: coeffVar, longBreaksCount, hasNightDip, roundSumRatio, activeDaysRatio, score };
}

function tokenPnls(swaps: SwapRow[]): TokenPnl[] {
  const m = new Map<string, TokenPnl>();
  for (const s of swaps) {
    let cur = m.get(s.baseMint);
    if (!cur) { cur = { mint: s.baseMint, buys: 0, sells: 0, netPnl: 0, tradeCount: 0 }; m.set(s.baseMint, cur); }
    if (s.side === 'buy') cur.buys += s.amountUsd;
    else cur.sells += s.amountUsd;
    cur.netPnl = cur.sells - cur.buys;
    cur.tradeCount++;
  }
  return [...m.values()];
}

function detectTimezone(swaps: SwapRow[]): { utcOffsetGuess: number; nightStart: number; nightEnd: number } | null {
  if (swaps.length < 30) return null;
  const hist = new Array(24).fill(0);
  for (const s of swaps) hist[s.ts.getUTCHours()]++;
  // ищем 6-часовое окно с минимумом активности — предположительно ночь местная
  let bestStart = 0;
  let bestSum = Infinity;
  for (let h = 0; h < 24; h++) {
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += hist[(h + k) % 24];
    if (sum < bestSum) { bestSum = sum; bestStart = h; }
  }
  // допустим, его «ночь» = bestStart..bestStart+6 (UTC). Сделаем оценку часового пояса:
  // местная ночь обычно 23:00-05:00 (центр в 02:00). Если центр UTC окна — bestStart+3,
  // то utcOffset = (2 - (bestStart+3) + 24) % 24, потом нормализуем в -12..+14
  let off = (2 - (bestStart + 3) + 48) % 24;
  if (off > 12) off -= 24;
  return { utcOffsetGuess: off, nightStart: bestStart, nightEnd: (bestStart + 6) % 24 };
}

function holdingTimes(swaps: SwapRow[]): number[] {
  // Для каждого mint: для каждой пары buy → sell в порядке по времени
  const times: number[] = [];
  const byMint = new Map<string, SwapRow[]>();
  for (const s of swaps) {
    let arr = byMint.get(s.baseMint);
    if (!arr) { arr = []; byMint.set(s.baseMint, arr); }
    arr.push(s);
  }
  for (const arr of byMint.values()) {
    arr.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    let openBuyTs: number | null = null;
    for (const s of arr) {
      if (s.side === 'buy' && openBuyTs == null) {
        openBuyTs = s.ts.getTime();
      } else if (s.side === 'sell' && openBuyTs != null) {
        times.push((s.ts.getTime() - openBuyTs) / 60000);  // в минутах
        openBuyTs = null;
      }
    }
  }
  return times;
}

function fmtMins(m: number): string {
  if (m < 60) return `${m.toFixed(0)}min`;
  if (m < 1440) return `${(m/60).toFixed(1)}h`;
  return `${(m/1440).toFixed(1)}d`;
}

async function printDossier(client: pg.PoolClient, cand: Candidate, hs: HumanScore, swaps: SwapRow[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`WALLET: ${cand.wallet}`);
  console.log(`Solscan: https://solscan.io/account/${cand.wallet}`);
  console.log(`Photon:  https://photon-sol.tinyastro.io/en/r/@photon/${cand.wallet}`);
  console.log(`GMGN:    https://gmgn.ai/sol/address/${cand.wallet}`);
  console.log(`${'='.repeat(70)}`);

  // Stats
  console.log(`\n[STATS — за ${LOOKBACK_DAYS} дней по нашей БД]`);
  console.log(`  swaps:           ${cand.swapCount}`);
  console.log(`  unique tokens:   ${cand.uniqueTokens}`);
  console.log(`  active days:     ${cand.activeDays} / ${LOOKBACK_DAYS} (${(hs.activeDaysRatio*100).toFixed(0)}%)`);
  console.log(`  total volume:    $${cand.totalVolumeUsd.toFixed(0)}`);
  console.log(`  net P&L proxy:   $${cand.pnlProxy.toFixed(0)}  (sells - buys по объёму)`);
  console.log(`  avg trade size:  $${cand.avgTradeUsd.toFixed(0)}`);
  console.log(`  first swap:      ${cand.firstSwapAt.toISOString()}`);
  console.log(`  last swap:       ${cand.lastSwapAt.toISOString()}`);

  // Humanness
  console.log(`\n[HUMANNESS — score ${hs.score}/5]`);
  console.log(`  ✓ Дисперсия интервалов:  cv=${hs.intervalCoeffVar.toFixed(2)}  ${hs.intervalCoeffVar>2 ? '(человек)' : '(ровный bot-pattern)'}`);
  console.log(`  ✓ Длинных пауз >72h:     ${hs.longBreaksCount}`);
  console.log(`  ✓ Ночной провал:         ${hs.hasNightDip ? 'ДА (выраженный)' : 'нет'}`);
  console.log(`  ✓ Круглых сумм:          ${(hs.roundSumRatio*100).toFixed(1)}%`);
  console.log(`  ✓ Активные дни:          ${(hs.activeDaysRatio*100).toFixed(0)}%`);

  // Timezone
  const tz = detectTimezone(swaps);
  if (tz) {
    const sign = tz.utcOffsetGuess >= 0 ? '+' : '';
    console.log(`\n[TIMEZONE GUESS]  UTC${sign}${tz.utcOffsetGuess}  (тихие часы UTC ${tz.nightStart}-${tz.nightEnd})`);
  }

  // Holding time
  const ht = holdingTimes(swaps);
  if (ht.length >= 5) {
    const sorted = [...ht].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    console.log(`\n[HOLDING TIME — на ${ht.length} закрытых позициях]`);
    console.log(`  median:  ${fmtMins(med)}`);
    console.log(`  p25-p75: ${fmtMins(p25)} – ${fmtMins(p75)}`);
  }

  // Token P&L
  const tps = tokenPnls(swaps);
  const wins = [...tps].sort((a, b) => b.netPnl - a.netPnl).slice(0, 5);
  const losses = [...tps].filter(t => t.netPnl < 0).sort((a, b) => a.netPnl - b.netPnl).slice(0, 5);
  console.log(`\n[TOP 5 ВЫИГРЫШНЫХ ТОКЕНОВ]`);
  for (const t of wins) {
    console.log(`  ${t.mint.slice(0,8)}…  +$${t.netPnl.toFixed(0)}  trades=${t.tradeCount}  https://dexscreener.com/solana/${t.mint}`);
  }
  if (losses.length) {
    console.log(`\n[TOP 5 ПРОИГРЫШНЫХ ТОКЕНОВ]`);
    for (const t of losses) {
      console.log(`  ${t.mint.slice(0,8)}…  $${t.netPnl.toFixed(0)}  trades=${t.tradeCount}  https://dexscreener.com/solana/${t.mint}`);
    }
  }

  // Top traded tokens (by trade count)
  const byCnt = [...tps].sort((a, b) => b.tradeCount - a.tradeCount).slice(0, 10);
  console.log(`\n[TOP 10 ПО ЧАСТОТЕ ТРЕЙДОВ]`);
  for (const t of byCnt) {
    console.log(`  ${t.mint.slice(0,8)}…  trades=${t.tradeCount}  buys=$${t.buys.toFixed(0)} sells=$${t.sells.toFixed(0)} net=${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(0)}`);
  }
}

async function main() {
  console.log(`\n=== Human Trader Discovery ===`);
  console.log(`Lookback: ${LOOKBACK_DAYS}d  |  swaps: [${MIN_SWAPS}–${MAX_SWAPS}]  |  min uniq tokens: ${MIN_UNIQUE_TOKENS}  |  min net P&L: $${MIN_PNL_USD}\n`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('STAGE 1 — кандидаты по жёсткому SQL-фильтру...');
    const cands = await loadCandidates(client);
    console.log(`  found: ${cands.length} кандидатов\n`);

    if (cands.length === 0) {
      console.log('Ничего не подошло. Возможно, надо ослабить пороги (MIN_SWAPS / MIN_PNL_USD).');
      return;
    }

    console.log('STAGE 2 — humanness scoring каждого кандидата...');
    const scored: { cand: Candidate; hs: HumanScore; swaps: SwapRow[] }[] = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      process.stderr.write(`  [${i+1}/${cands.length}] ${c.wallet.slice(0,8)}…  swaps=${c.swapCount} pnl=$${c.pnlProxy.toFixed(0)}  `);
      const swaps = await loadSwaps(client, c.wallet);
      const hs = computeHumanScore(swaps, c);
      scored.push({ cand: c, hs, swaps });
      process.stderr.write(`humanScore=${hs.score}/5\n`);
    }

    // Сортируем: сначала human score, при равенстве — net P&L
    scored.sort((a, b) => {
      if (b.hs.score !== a.hs.score) return b.hs.score - a.hs.score;
      return b.cand.pnlProxy - a.cand.pnlProxy;
    });

    console.log(`\nSTAGE 2.5 — short list (humanScore >= 3, top ${TOP_K_FINALISTS}):`);
    const finalists = scored.filter(s => s.hs.score >= 3).slice(0, TOP_K_FINALISTS);
    if (finalists.length === 0) {
      console.log('  Ни один кандидат не набрал humanScore >= 3 — все выглядят bot-like.');
      console.log('  Показываю топ-5 по P&L всё равно:');
      finalists.push(...scored.slice(0, 5));
    } else {
      for (const f of finalists) {
        console.log(`  ${f.cand.wallet.slice(0,8)}…  hs=${f.hs.score}/5  pnl=$${f.cand.pnlProxy.toFixed(0)}  swaps=${f.cand.swapCount}  uniq=${f.cand.uniqueTokens}  active=${f.cand.activeDays}d`);
      }
    }

    console.log(`\nSTAGE 3 — досье на финалистов:`);
    for (const f of finalists) {
      await printDossier(client, f.cand, f.hs, f.swaps);
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`DONE. Финалистов: ${finalists.length}.`);
    console.log(`Открой Solscan/Photon/GMGN ссылки для тех кто заинтересовал — ручной ревью даст больше чем любой алгоритм.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
