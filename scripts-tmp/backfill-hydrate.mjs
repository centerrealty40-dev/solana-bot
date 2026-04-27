#!/usr/bin/env node
import {
  DEFAULT_PROGRAMS,
  QUOTE_MINTS,
  RotatingRpc,
  POSTGRES_MAX_BIGINT,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  ensureBackfillSchema,
  finishRun,
  log,
  pool,
  shortError,
  sleep,
  startRun,
  targetDays,
} from './backfill-common.mjs';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? (process.argv[idx + 1] ?? fallback) : fallback;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bigintToDecimalNumber(raw, decimals) {
  const s = raw.toString();
  if (decimals <= 0) return Number(s);
  const padded = s.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return Number(frac ? `${whole}.${frac}` : whole);
}

function compareAbsDesc(a, b) {
  const av = absBigInt(a.raw);
  const bv = absBigInt(b.raw);
  if (av === bv) return 0;
  return av > bv ? -1 : 1;
}

function accountKeyString(key) {
  if (!key) return null;
  if (typeof key === 'string') return key;
  return key.pubkey?.toString?.() || key.pubkey || null;
}

function tokenAmountRaw(balance) {
  try {
    return BigInt(balance?.uiTokenAmount?.amount ?? '0');
  } catch {
    return 0n;
  }
}

function tokenDecimals(balance) {
  return num(balance?.uiTokenAmount?.decimals, 0);
}

function addMintDelta(map, mint, rawDelta, decimals) {
  if (!mint || rawDelta === 0n) return;
  const cur = map.get(mint) || { mint, raw: 0n, decimals };
  cur.raw += rawDelta;
  cur.decimals = Math.max(cur.decimals ?? decimals, decimals);
  map.set(mint, cur);
}

function buildOwnerTokenDeltas(tx, owner) {
  const deltas = new Map();
  for (const b of tx?.meta?.preTokenBalances || []) {
    if (b.owner !== owner) continue;
    addMintDelta(deltas, b.mint, -tokenAmountRaw(b), tokenDecimals(b));
  }
  for (const b of tx?.meta?.postTokenBalances || []) {
    if (b.owner !== owner) continue;
    addMintDelta(deltas, b.mint, tokenAmountRaw(b), tokenDecimals(b));
  }
  return deltas;
}

function nativeSolDeltaRaw(tx, owner) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => accountKeyString(k) === owner);
  if (idx < 0) return 0n;
  const pre = BigInt(Math.trunc(num(tx?.meta?.preBalances?.[idx], 0)));
  const post = BigInt(Math.trunc(num(tx?.meta?.postBalances?.[idx], 0)));
  const feePayer = accountKeyString(keys[0]);
  const fee = feePayer === owner ? BigInt(Math.trunc(num(tx?.meta?.fee, 0))) : 0n;
  return post - pre + fee;
}

function feePayer(tx) {
  return accountKeyString(tx?.transaction?.message?.accountKeys?.[0]);
}

function signerCandidates(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const out = [];
  for (const k of keys) {
    if (k?.signer) {
      const pk = accountKeyString(k);
      if (pk) out.push(pk);
    }
  }
  const payer = feePayer(tx);
  return [...new Set([payer, ...out].filter(Boolean))];
}

function detectDex(program, tx) {
  const source = `${program || ''} ${JSON.stringify(tx?.transaction?.message?.instructions || []).slice(0, 5000)}`.toLowerCase();
  if (source.includes('raydium') || DEFAULT_PROGRAMS.some((p) => p.dex === 'raydium' && source.includes(p.address.toLowerCase()))) return 'raydium';
  if (source.includes('meteora') || DEFAULT_PROGRAMS.some((p) => p.dex === 'meteora' && source.includes(p.address.toLowerCase()))) return 'meteora';
  if (source.includes('orca') || source.includes('whirlpool') || DEFAULT_PROGRAMS.some((p) => p.dex === 'orca' && source.includes(p.address.toLowerCase()))) return 'orca';
  if (source.includes('pump') || DEFAULT_PROGRAMS.some((p) => p.dex === 'pumpfun' && source.includes(p.address.toLowerCase()))) return 'pumpfun';
  return 'unknown';
}

function quotePrice(mint, solUsd) {
  if (mint === USDC_MINT || mint === USDT_MINT) return 1;
  if (mint === SOL_MINT) return solUsd;
  return 0;
}

function parseSwaps(signature, program, tx, solUsd) {
  if (!tx?.blockTime || tx?.meta?.err) return [];
  const rows = [];
  const dex = detectDex(program, tx);
  const candidates = signerCandidates(tx);

  for (const owner of candidates) {
    const deltas = buildOwnerTokenDeltas(tx, owner);
    const solRaw = nativeSolDeltaRaw(tx, owner);
    if (solRaw !== 0n) addMintDelta(deltas, SOL_MINT, solRaw, 9);
    if (deltas.size < 2) continue;

    const quotes = [...deltas.values()]
      .filter((d) => QUOTE_MINTS.has(d.mint) && d.raw !== 0n)
      .sort(compareAbsDesc);
    const quote = quotes[0];
    if (!quote) continue;
    const qPrice = quotePrice(quote.mint, solUsd);
    if (qPrice <= 0) continue;
    const quoteRaw = absBigInt(quote.raw);
    if (quoteRaw > POSTGRES_MAX_BIGINT) continue;
    const quoteAmount = bigintToDecimalNumber(quoteRaw, quote.decimals);
    if (quoteAmount <= 0) continue;

    for (const base of deltas.values()) {
      if (base.mint === quote.mint || QUOTE_MINTS.has(base.mint) || base.raw === 0n) continue;
      if ((base.raw > 0n) === (quote.raw > 0n)) continue;
      const baseRaw = absBigInt(base.raw);
      if (baseRaw > POSTGRES_MAX_BIGINT) continue;
      const baseAmount = bigintToDecimalNumber(baseRaw, base.decimals);
      if (baseAmount <= 0) continue;
      const amountUsd = quoteAmount * qPrice;
      if (amountUsd <= 0) continue;
      rows.push({
        signature,
        slot: tx.slot,
        blockTime: new Date(tx.blockTime * 1000),
        wallet: owner,
        baseMint: base.mint,
        quoteMint: quote.mint,
        side: base.raw > 0n ? 'buy' : 'sell',
        baseAmountRaw: baseRaw.toString(),
        quoteAmountRaw: quoteRaw.toString(),
        priceUsd: amountUsd / baseAmount,
        amountUsd,
        dex,
      });
    }
  }

  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.signature}:${r.wallet}:${r.baseMint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absBigInt(v) {
  return v < 0n ? -v : v;
}

async function fetchSolUsd() {
  const fallback = Number(process.env.SOL_USD || 150);
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
    const j = await r.json();
    return num(j?.[SOL_MINT]?.usdPrice ?? j?.data?.[SOL_MINT]?.price, fallback);
  } catch {
    return fallback;
  }
}

async function takeBatch(limit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE backfill_signatures
      SET status='queued', updated_at=now(), last_error='requeued stale processing lock'
      WHERE status='processing'
        AND updated_at < now() - interval '30 minutes'
        AND attempts < 5
    `);
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT signature
         FROM backfill_signatures
         WHERE status='queued'
           AND (block_time IS NULL OR block_time >= now() - ($1::int * interval '1 day'))
         ORDER BY block_time DESC NULLS LAST, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE backfill_signatures bs
       SET status='processing', attempts=attempts+1, updated_at=now(), last_error=NULL
       FROM picked
       WHERE bs.signature=picked.signature
       RETURNING bs.signature, bs.program, bs.attempts`,
      [targetDays(), limit],
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function commitResults(results) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const result of results) {
      if (result.ok) {
        for (const row of result.rows) {
          const res = await client.query(
            `INSERT INTO swaps (
               signature, slot, block_time, wallet, base_mint, quote_mint, side,
               base_amount_raw, quote_amount_raw, price_usd, amount_usd, dex, source
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'rpc_backfill')
             ON CONFLICT (signature, wallet, base_mint) DO NOTHING`,
            [
              row.signature,
              row.slot,
              row.blockTime,
              row.wallet,
              row.baseMint,
              row.quoteMint,
              row.side,
              row.baseAmountRaw,
              row.quoteAmountRaw,
              row.priceUsd,
              row.amountUsd,
              row.dex,
            ],
          );
          inserted += res.rowCount;
        }
        await client.query(
          `UPDATE backfill_signatures
           SET status='done', updated_at=now(), last_error=NULL
           WHERE signature=$1`,
          [result.signature],
        );
      } else {
        await client.query(
          `UPDATE backfill_signatures
           SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
               updated_at = now(),
               last_error = $2
           WHERE signature=$1`,
          [result.signature, result.error],
        );
      }
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function worker(id, options) {
  const rpc = new RotatingRpc({ minIntervalMs: Number(process.env.BACKFILL_HYDRATE_INTERVAL_MS || 1500) });
  let processed = 0;
  let inserted = 0;
  let solUsd = await fetchSolUsd();
  let solUsdFetchedAt = Date.now();

  for (;;) {
    if (Date.now() - solUsdFetchedAt > Number(process.env.BACKFILL_SOL_PRICE_REFRESH_MS || 300_000)) {
      solUsd = await fetchSolUsd();
      solUsdFetchedAt = Date.now();
    }
    if (options.limit > 0 && processed >= options.limit) break;
    const batchLimit = Math.min(options.batchSize, options.limit > 0 ? options.limit - processed : options.batchSize);
    const batch = await takeBatch(batchLimit);
    if (!batch.length) {
      log('info', 'hydrator idle; no queued signatures', { worker: id, processed, inserted });
      if (options.once) break;
      await sleep(Number(process.env.BACKFILL_HYDRATE_IDLE_MS || 5000));
      continue;
    }

    const results = [];
    for (const task of batch) {
      try {
        const tx = await rpc.request('getTransaction', [
          task.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ]);
        results.push({ signature: task.signature, ok: true, rows: parseSwaps(task.signature, task.program, tx, solUsd) });
      } catch (err) {
        results.push({ signature: task.signature, ok: false, error: shortError(err) });
      }
    }
    inserted += await commitResults(results);
    processed += batch.length;
    log('info', 'hydrator progress', {
      worker: id,
      processed,
      inserted,
      batch: batch.length,
      swaps_found: results.reduce((sum, r) => sum + (r.rows?.length || 0), 0),
      errors: results.filter((r) => !r.ok).length,
      sol_usd: solUsd,
    });
  }

  return { worker: id, processed, inserted };
}

async function main() {
  await ensureBackfillSchema();
  const workers = Number(arg('workers', process.env.BACKFILL_HYDRATORS || 1));
  const limit = Number(arg('limit', process.env.BACKFILL_HYDRATE_LIMIT || 0));
  const batchSize = Number(arg('batch-size', process.env.BACKFILL_HYDRATE_BATCH || 50));
  const once = limit > 0 || process.argv.includes('--once');
  const perWorkerLimit = limit > 0 ? Math.ceil(limit / Math.max(1, workers)) : 0;
  const runId = await startRun('backfill-hydrate', targetDays());
  log('info', 'hydrator start', { workers, limit, per_worker_limit: perWorkerLimit, batch_size: batchSize, once });

  try {
    const results = await Promise.all(Array.from({ length: Math.max(1, workers) }, (_, i) => worker(i + 1, { limit: perWorkerLimit, batchSize, once })));
    await finishRun(runId, 'done', { results });
    log('info', 'hydrator done', { results });
  } catch (err) {
    await finishRun(runId, 'failed', { error: shortError(err) });
    log('error', 'hydrator failed', { error: shortError(err) });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
