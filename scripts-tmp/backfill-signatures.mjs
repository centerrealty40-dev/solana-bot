#!/usr/bin/env node
import {
  DEFAULT_PROGRAMS,
  RotatingRpc,
  cutoffUnix,
  ensureBackfillSchema,
  finishRun,
  log,
  pool,
  shortError,
  startRun,
  targetDays,
} from './backfill-common.mjs';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? (process.argv[idx + 1] ?? fallback) : fallback;
}

function asBool(value) {
  return !['0', 'false', 'no', 'off'].includes(String(value ?? '').toLowerCase());
}

function normalizedProgramName(row) {
  return String(row.name || row.slug || row.program_id || row.address || '').toLowerCase();
}

async function loadTargets() {
  const only = String(arg('programs', process.env.BACKFILL_PROGRAMS || '') || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const defaults = DEFAULT_PROGRAMS.filter((p) => !only.length || only.some((needle) => p.name.includes(needle) || p.dex.includes(needle)));

  try {
    const { rows } = await pool.query(`
      SELECT program_id, name, slug, metadata
      FROM programs
      WHERE chain = 'solana'
        AND (
          lower(coalesce(name, '')) ~ '(pump|raydium|meteora|orca)'
          OR lower(coalesce(slug, '')) ~ '(pump|raydium|meteora|orca)'
          OR program_id = ANY($1::text[])
        )
    `, [DEFAULT_PROGRAMS.map((p) => p.address)]);
    const fromDb = rows
      .map((r) => ({
        name: normalizedProgramName(r),
        address: r.program_id,
        dex: detectDex(`${r.name || ''} ${r.slug || ''}`),
      }))
      .filter((p) => p.address && p.address.length >= 32 && (!only.length || only.some((needle) => p.name.includes(needle) || p.dex.includes(needle))));
    const byAddress = new Map([...defaults, ...fromDb].map((p) => [p.address, p]));
    return [...byAddress.values()];
  } catch (err) {
    log('warn', 'programs table lookup failed; using built-in target list', { error: shortError(err) });
    return defaults;
  }
}

function detectDex(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('raydium')) return 'raydium';
  if (s.includes('meteora')) return 'meteora';
  if (s.includes('orca') || s.includes('whirlpool')) return 'orca';
  if (s.includes('pump')) return 'pumpfun';
  return 'unknown';
}

async function insertBatch(program, signatures, dryRun) {
  if (dryRun || !signatures.length) return { inserted: 0 };
  const params = [];
  const values = signatures.map((sig, i) => {
    const off = i * 4;
    params.push(sig.signature, program.address, sig.slot ?? null, sig.blockTime ? new Date(sig.blockTime * 1000) : null);
    return `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4})`;
  });
  const { rowCount } = await pool.query(
    `INSERT INTO backfill_signatures (signature, program, slot, block_time)
     VALUES ${values.join(',')}
     ON CONFLICT (signature) DO NOTHING`,
    params,
  );
  return { inserted: rowCount };
}

async function crawlProgram(rpc, program, days, dryRun) {
  const cutoff = cutoffUnix(days);
  const maxPages = Number(arg('max-pages', process.env.BACKFILL_CRAWLER_MAX_PAGES || 0));
  let before = arg('before', null);
  let pages = 0;
  let seen = 0;
  let inserted = 0;
  let oldest = null;

  for (;;) {
    pages++;
    const batch = await rpc.request('getSignaturesForAddress', [
      program.address,
      { limit: 1000, before: before || undefined },
    ]);
    if (!batch?.length) break;

    before = batch[batch.length - 1].signature;
    seen += batch.length;
    const inWindow = [];
    let reachedCutoff = false;
    for (const sig of batch) {
      if (sig.blockTime) {
        oldest = sig.blockTime;
        if (sig.blockTime < cutoff) {
          reachedCutoff = true;
          continue;
        }
      }
      if (sig.signature) inWindow.push(sig);
    }
    const res = await insertBatch(program, inWindow, dryRun);
    inserted += res.inserted;

    log('info', 'crawler progress', {
      program: program.name,
      address: program.address,
      page: pages,
      seen,
      inserted,
      page_count: batch.length,
      oldest_block_time: oldest ? new Date(oldest * 1000).toISOString() : null,
      dry_run: dryRun,
    });

    if (reachedCutoff || batch.length < 1000 || (maxPages > 0 && pages >= maxPages)) break;
  }
  return { program: program.name, address: program.address, seen, inserted, oldest_block_time: oldest ? new Date(oldest * 1000).toISOString() : null };
}

async function main() {
  await ensureBackfillSchema();
  const days = Number(arg('days', targetDays()));
  const dryRun = asBool(arg('dry-run', process.env.BACKFILL_DRY_RUN || '0'));
  const runId = dryRun ? null : await startRun('backfill-signatures', days);
  const rpc = new RotatingRpc({ minIntervalMs: Number(process.env.BACKFILL_CRAWLER_INTERVAL_MS || 900) });
  const targets = await loadTargets();
  const results = [];

  log('info', 'crawler start', { days, target_count: targets.length, endpoints: rpc.endpoints.length, dry_run: dryRun });
  try {
    for (const program of targets) {
      results.push(await crawlProgram(rpc, program, days, dryRun));
    }
    if (runId) await finishRun(runId, 'done', { results });
    log('info', 'crawler done', { results });
  } catch (err) {
    if (runId) await finishRun(runId, 'failed', { error: shortError(err), results });
    log('error', 'crawler failed', { error: shortError(err) });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
