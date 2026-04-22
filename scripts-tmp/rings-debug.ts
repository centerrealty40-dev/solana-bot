/**
 * Debug-скрипт для калибровки параметров ring-detector.
 *
 * Покажет:
 *   - сколько свежих swaps в таблице за разные окна (10м, 1ч, 6ч, 24ч)
 *   - сколько mint'ов с >=N покупателей в окне
 *   - примеры топовых кандидатов
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

async function rows<T = any>(q: any): Promise<T[]> {
  const r: any = await db.execute(q);
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function main() {
  console.log('='.repeat(72));
  console.log('SWAPS table snapshot');
  console.log('='.repeat(72));

  // total + recency
  const tot = await rows(dsql.raw(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE block_time > now() - interval '10 minutes') AS last_10m,
      COUNT(*) FILTER (WHERE block_time > now() - interval '1 hour')     AS last_1h,
      COUNT(*) FILTER (WHERE block_time > now() - interval '6 hours')    AS last_6h,
      COUNT(*) FILTER (WHERE block_time > now() - interval '24 hours')   AS last_24h,
      MAX(block_time) AS newest
    FROM swaps
  `));
  console.log(tot[0]);

  // buys breakdown
  const buys = await rows(dsql.raw(`
    SELECT
      COUNT(*) FILTER (WHERE side='buy' AND amount_usd >= 100) AS buys_100usd_24h,
      COUNT(*) FILTER (WHERE side='buy' AND amount_usd >= 50)  AS buys_50usd_24h,
      COUNT(*) FILTER (WHERE side='buy' AND amount_usd >= 10)  AS buys_10usd_24h,
      COUNT(DISTINCT base_mint) FILTER (WHERE side='buy')      AS uniq_mints_24h
    FROM swaps
    WHERE block_time > now() - interval '24 hours'
  `));
  console.log('\nBuys (24h):');
  console.log(buys[0]);

  // mints with >=N buyers in any 3-min window (24h)
  for (const minB of [3, 4, 5, 7, 10]) {
    const r = await rows(dsql.raw(`
      WITH b AS (
        SELECT base_mint, wallet, block_time
        FROM swaps
        WHERE side='buy' AND amount_usd >= 50
          AND block_time > now() - interval '24 hours'
      )
      SELECT COUNT(*) AS n_mints
      FROM (
        SELECT base_mint, COUNT(DISTINCT wallet) AS uniq
        FROM b
        GROUP BY base_mint
      ) x
      WHERE uniq >= ${minB}
    `));
    console.log(`mints with >=${minB} unique buyers (≥$50) in last 24h: ${r[0].n_mints}`);
  }

  // топ 10 mint'ов по уникальным покупателям за 24ч
  console.log('\nTOP-10 mints by unique buyers (≥$50, last 24h):');
  const top = await rows(dsql.raw(`
    SELECT base_mint, COUNT(DISTINCT wallet) AS buyers,
           SUM(amount_usd)::int AS total_usd,
           MIN(block_time) AS first_buy, MAX(block_time) AS last_buy
    FROM swaps
    WHERE side='buy' AND amount_usd >= 50
      AND block_time > now() - interval '24 hours'
    GROUP BY base_mint
    ORDER BY buyers DESC
    LIMIT 10
  `));
  for (const t of top) {
    console.log(`  ${t.base_mint}  buyers=${t.buyers}  vol=$${t.total_usd}  span=${t.first_buy.toISOString().slice(0,16)} → ${t.last_buy.toISOString().slice(0,16)}`);
  }

  // самый свежий ring: топ кандидаты в последний час
  console.log('\nFRESH (last 1h) — mints with >=3 unique buyers ≥$50 in any 3-min window:');
  const fresh = await rows(dsql.raw(`
    WITH b AS (
      SELECT base_mint, wallet, block_time, amount_usd
      FROM swaps
      WHERE side='buy' AND amount_usd >= 50
        AND block_time > now() - interval '1 hour'
    )
    SELECT base_mint,
           COUNT(DISTINCT wallet) AS buyers,
           SUM(amount_usd)::int AS total_usd,
           MIN(block_time) AS first, MAX(block_time) AS last
    FROM b
    GROUP BY base_mint
    HAVING COUNT(DISTINCT wallet) >= 3
    ORDER BY buyers DESC
    LIMIT 20
  `));
  if (fresh.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of fresh) {
      console.log(`  ${f.base_mint}  buyers=${f.buyers}  vol=$${f.total_usd}  ${f.first.toISOString().slice(11,19)} → ${f.last.toISOString().slice(11,19)}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
