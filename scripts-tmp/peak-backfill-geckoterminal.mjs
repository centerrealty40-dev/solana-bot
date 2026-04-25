// Peak backfill через pump.fun API + GeckoTerminal
//
// 1. Находим в DB все mints с our_peak > $40K (близко к graduation $69K)
// 2. Дёргаем pump.fun /coins/{mint} → smотрим complete + raydium_pool / pump_swap_pool
// 3. Если graduated → GeckoTerminal /networks/solana/pools/{pool}/ohlcv/hour
// 4. Извлекаем true peak за всю историю pool
// 5. Сохраняем в historical_peaks
//
// Bесплатные лимиты: pump.fun ~5 RPS, GeckoTerminal ~30 RPS. Используем 4 RPS суммарно.

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MIN_PEAK_USD = Number(process.env.MIN_PEAK_USD || 40000);
const RPS = Number(process.env.RPS || 4);
const SLEEP_MS = 1000 / RPS;

async function fetchPumpFun(mint) {
  const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error(`pumpfun HTTP ${r.status}`);
  return await r.json();
}

async function fetchGeckoOhlcv(pool, timeframe = 'hour') {
  // GeckoTerminal: /networks/{network}/pools/{address}/ohlcv/{timeframe}?aggregate=1&limit=1000
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${timeframe}?aggregate=1&limit=1000`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`gecko HTTP ${r.status}`);
  return await r.json();
}

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historical_peaks (
      mint TEXT PRIMARY KEY,
      our_peak_mc_usd NUMERIC,
      pumpfun_current_mc_usd NUMERIC,
      true_peak_mc_usd NUMERIC,
      undershoot_x NUMERIC,
      symbol TEXT,
      name TEXT,
      complete BOOLEAN,
      pool_address TEXT,
      ohlcv_candles INT,
      api_source TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      error TEXT
    )
  `);
  console.log('[init] table historical_peaks ready');

  const { rows: candidates } = await pool.query(`
    WITH peaks AS (
      SELECT base_mint, MAX(price_usd) * 1e9 AS our_peak,
             MIN(block_time) AS launched, MAX(block_time) AS last_seen
      FROM swaps
      WHERE source = 'pumpportal'
        AND base_mint NOT LIKE 'So111%'
        AND price_usd > 0 AND price_usd < 1000
      GROUP BY base_mint
      HAVING MAX(price_usd) * 1e9 > $1
    )
    SELECT base_mint, our_peak, launched
    FROM peaks
    WHERE base_mint NOT IN (SELECT mint FROM historical_peaks WHERE error IS NULL OR error LIKE 'pumpfun%')
    ORDER BY our_peak DESC
  `, [MIN_PEAK_USD]);

  console.log(`[plan] ${candidates.length} candidates (peak > $${MIN_PEAK_USD})`);
  console.log(`[plan] estimated time: ${Math.round(candidates.length * 2 * SLEEP_MS / 1000 / 60)} min at ${RPS} RPS\n`);

  let success = 0, errors = 0, graduated = 0;
  const t0 = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const mint = c.base_mint;
    let pumpData = null, ohlcv = null, truePeak = null, poolAddr = null, err = null;

    try {
      pumpData = await fetchPumpFun(mint);
    } catch (e) {
      err = `pumpfun: ${String(e?.message || e).slice(0,80)}`;
    }
    await new Promise(r => setTimeout(r, SLEEP_MS));

    if (pumpData && pumpData.complete) {
      graduated++;
      poolAddr = pumpData.raydium_pool || pumpData.pump_swap_pool || null;
      if (poolAddr) {
        try {
          ohlcv = await fetchGeckoOhlcv(poolAddr, 'hour');
          const candles = ohlcv?.data?.attributes?.ohlcv_list || [];
          // OHLCV format: [ts, open, high, low, close, volume]
          // peak = max of high
          if (candles.length > 0) {
            const maxHigh = candles.reduce((m, c) => Math.max(m, c[2]), 0);
            const supply = pumpData.total_supply ? Number(pumpData.total_supply) / 1e6 : 1e9;
            truePeak = maxHigh * supply;
          }
        } catch (e) {
          err = `gecko: ${String(e?.message || e).slice(0,80)}`;
        }
        await new Promise(r => setTimeout(r, SLEEP_MS));
      }
    }

    const ourPeak = Number(c.our_peak);
    const undershoot = truePeak && ourPeak ? truePeak / ourPeak : null;

    await pool.query(`
      INSERT INTO historical_peaks (mint, our_peak_mc_usd, pumpfun_current_mc_usd, true_peak_mc_usd, undershoot_x, symbol, name, complete, pool_address, ohlcv_candles, api_source, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (mint) DO UPDATE SET
        pumpfun_current_mc_usd = EXCLUDED.pumpfun_current_mc_usd,
        true_peak_mc_usd = EXCLUDED.true_peak_mc_usd,
        undershoot_x = EXCLUDED.undershoot_x,
        complete = EXCLUDED.complete,
        pool_address = EXCLUDED.pool_address,
        ohlcv_candles = EXCLUDED.ohlcv_candles,
        api_source = EXCLUDED.api_source,
        fetched_at = NOW(),
        error = EXCLUDED.error
    `, [
      mint, ourPeak,
      pumpData?.usd_market_cap ? Number(pumpData.usd_market_cap) : null,
      truePeak,
      undershoot,
      pumpData?.symbol || null,
      pumpData?.name || null,
      pumpData?.complete || false,
      poolAddr,
      ohlcv?.data?.attributes?.ohlcv_list?.length || 0,
      ohlcv ? 'pumpfun+geckoterminal' : (pumpData ? 'pumpfun' : 'error'),
      err,
    ]);

    if (err) errors++; else success++;

    if ((i + 1) % 25 === 0 || i === candidates.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (candidates.length - i - 1) / rate;
      console.log(`  [${i+1}/${candidates.length}] ok=${success} grad=${graduated} err=${errors} | ${rate.toFixed(1)} req/s | eta ${(eta/60).toFixed(1)} min`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`processed: ${candidates.length} / success: ${success} / graduated: ${graduated} / errors: ${errors}`);

  // финальный отчёт
  const { rows: stats } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE complete = true) AS graduated,
      COUNT(*) FILTER (WHERE undershoot_x > 2) AS undershoot_2x,
      COUNT(*) FILTER (WHERE undershoot_x > 5) AS undershoot_5x,
      COUNT(*) FILTER (WHERE true_peak_mc_usd > 100000) AS real_runners_100k,
      COUNT(*) FILTER (WHERE true_peak_mc_usd > 500000) AS real_runners_500k,
      COUNT(*) FILTER (WHERE true_peak_mc_usd > 1000000) AS real_moonshots
    FROM historical_peaks
    WHERE error IS NULL
  `);
  console.log('\n=== INSIGHTS ===');
  console.log(JSON.stringify(stats[0], null, 2));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
