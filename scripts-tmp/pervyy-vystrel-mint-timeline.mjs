#!/usr/bin/env node
/**
 * Read-only forensics: PG snapshot + journal timeline for a mint (Pervyy Vystrel PR1).
 *
 * Usage:
 *   node scripts-tmp/pervyy-vystrel-mint-timeline.mjs <mint>
 *
 * Requires DATABASE_URL (or PG env from .env). No writes.
 */
import 'dotenv/config';
import pg from 'pg';

const mint = process.argv[2]?.trim();
if (!mint || mint.length < 32) {
  console.error('Usage: node scripts-tmp/pervyy-vystrel-mint-timeline.mjs <mint>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const tables = [
  'pumpswap_pair_snapshots',
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
];

console.log(`\n=== Pervyy Vystrel mint timeline: ${mint} ===\n`);

for (const table of tables) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts,
            MAX(COALESCE(market_cap_usd, fdv_usd, 0))::float AS peak_mcap,
            MAX(COALESCE(volume_1h, 0))::float AS peak_vol1h
     FROM ${table}
     WHERE base_mint = $1`,
    [mint],
  );
  const row = r.rows[0];
  if (Number(row.n) > 0) {
    console.log(`${table}: rows=${row.n} first=${row.first_ts} last=${row.last_ts} peak_mcap=${row.peak_mcap} peak_vol1h=${row.peak_vol1h}`);
  }
}

const tok = await client.query(
  `SELECT mint, symbol, holder_count, first_seen_at FROM tokens WHERE mint = $1`,
  [mint],
);
console.log('\ntokens:', tok.rows[0] ?? '(none)');

const swaps = await client.query(
  `SELECT COUNT(*)::int AS n, MIN(block_time) AS first_swap, MAX(block_time) AS last_swap FROM swaps WHERE base_mint = $1`,
  [mint],
);
console.log('swaps:', swaps.rows[0] ?? '(none)');

const journalPath = process.env.LIVE_TRADES_PATH ?? 'data/live/pt1-oscar-live.jsonl';
try {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(journalPath, 'utf8');
  const hits = [];
  for (const line of raw.split('\n')) {
    if (!line.includes(mint)) continue;
    if (
      !line.includes('pervyy_vystrel') &&
      !line.includes('live_discovery_eval') &&
      !line.includes('live_discovery_universe_miss')
    ) {
      continue;
    }
    try {
      const j = JSON.parse(line);
      if (j.mint === mint || line.includes(mint)) {
        hits.push({ ts: j.ts, kind: j.kind, pass: j.pass, reasons: j.reasons?.slice?.(0, 3) });
      }
    } catch {
      /* skip bad lines */
    }
  }
  console.log(`\njournal (${journalPath}) pervyy/discovery hits: ${hits.length}`);
  for (const h of hits.slice(-20)) {
    console.log(`  ts=${h.ts} kind=${h.kind} pass=${h.pass} reasons=${JSON.stringify(h.reasons ?? [])}`);
  }
} catch (e) {
  console.log('\njournal: skipped —', e instanceof Error ? e.message : String(e));
}

await client.end();
console.log('\nDone.\n');
