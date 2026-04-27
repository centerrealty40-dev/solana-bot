import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const STORE_PATH = process.env.PAPER_TRADES_PATH || '/opt/solana-alpha/data/paper-trades.jsonl';
const POSITION_USD = Number(process.env.POSITION_USD || 100);
const WINDOW_HOURS = Number(process.env.PM_WINDOW_HOURS || 48);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

function parseJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) { try { out.push(JSON.parse(ln)); } catch {} }
  return out;
}

function fmtPct(v) { const x = Number(v ?? 0); return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }
function fmtUsd(v) { const x = Number(v ?? 0); return `${x >= 0 ? '+' : ''}$${x.toFixed(0)}`; }

async function main() {
  const events = parseJsonl(STORE_PATH);
  if (!events.length) {
    console.log('No events found at', STORE_PATH);
    return;
  }

  const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
  const opens = new Map();
  for (const e of events) if (e.kind === 'open') opens.set(e.mint, e);

  const closes = events.filter((e) => e.kind === 'close' && (e.ts || 0) >= cutoff);

  const total = {
    n: closes.length,
    wins: 0,
    sumPct: 0,
    sumUsd: 0,
    sumPeak: 0,
    exits: { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0 },
    by_age: {},
    by_peak: {},
    by_exit_reason: {},
    migrated: { yes: 0, no: 0, sum_pnl_yes: 0, sum_pnl_no: 0 },
  };

  for (const c of closes) {
    if ((c.pnlPct ?? 0) > 0) total.wins++;
    total.sumPct += Number(c.pnlPct || 0);
    total.sumUsd += (POSITION_USD * Number(c.pnlPct || 0)) / 100;
    total.sumPeak += Number(c.peakPnlPct || 0);
    if (c.exitReason && total.exits[c.exitReason] != null) total.exits[c.exitReason]++;
  }

  const mints = closes.map((c) => c.mint).filter(Boolean);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  const migration = new Map();
  try {
    if (mints.length) {
      const valuesSql = mints.map((_, i) => `($${i + 1})`).join(',');
      const r = await client.query(
        `
        WITH targets(mint) AS (VALUES ${valuesSql})
        SELECT t.mint,
               BOOL_OR(rps.base_mint IS NOT NULL) AS in_raydium,
               BOOL_OR(mps.base_mint IS NOT NULL) AS in_meteora,
               BOOL_OR(ops.base_mint IS NOT NULL) AS in_orca
        FROM targets t
        LEFT JOIN raydium_pair_snapshots rps ON rps.base_mint = t.mint
        LEFT JOIN meteora_pair_snapshots mps ON mps.base_mint = t.mint
        LEFT JOIN orca_pair_snapshots ops ON ops.base_mint = t.mint
        GROUP BY t.mint
        `,
        mints,
      );
      for (const row of r.rows) {
        migration.set(String(row.mint), {
          inRaydium: !!row.in_raydium,
          inMeteora: !!row.in_meteora,
          inOrca: !!row.in_orca,
          anyDex: !!(row.in_raydium || row.in_meteora || row.in_orca),
        });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  for (const c of closes) {
    const o = opens.get(c.mint) || {};
    const ageMin = Number((o.features?.token_age_min ?? o.ageMin ?? 0));
    const peak = Number(c.peakPnlPct ?? 0);
    const reason = c.exitReason || 'UNKNOWN';
    const mig = migration.get(c.mint) || { anyDex: false };

    const ageBucket = ageMin < 5 ? 'age<5m'
      : ageMin < 10 ? 'age[5-10m]'
      : ageMin < 30 ? 'age[10-30m]'
      : 'age>30m';
    const peakBucket = peak <= 0 ? 'peak<=0%'
      : peak <= 25 ? 'peak[0-25%]'
      : peak <= 75 ? 'peak[25-75%]'
      : peak <= 200 ? 'peak[75-200%]'
      : 'peak>200%';

    total.by_age[ageBucket] = (total.by_age[ageBucket] || 0) + 1;
    total.by_peak[peakBucket] = (total.by_peak[peakBucket] || 0) + 1;
    total.by_exit_reason[reason] = (total.by_exit_reason[reason] || 0) + 1;

    if (mig.anyDex) {
      total.migrated.yes++;
      total.migrated.sum_pnl_yes += Number(c.pnlPct || 0);
    } else {
      total.migrated.no++;
      total.migrated.sum_pnl_no += Number(c.pnlPct || 0);
    }
  }

  const lines = [];
  lines.push(`Post-mortem · ${path.basename(STORE_PATH)} · last ${WINDOW_HOURS}h`);
  lines.push(`Closed: ${total.n}   Wins: ${total.wins} (${total.n ? (100 * total.wins / total.n).toFixed(0) : 0}%)`);
  lines.push(`Avg PnL: ${fmtPct(total.n ? total.sumPct / total.n : 0)}   Sum: ${fmtUsd(total.sumUsd)}   Avg peak: ${fmtPct(total.n ? total.sumPeak / total.n : 0)}`);
  lines.push('');
  lines.push('Exits:');
  for (const k of ['TP', 'SL', 'TRAIL', 'TIMEOUT', 'NO_DATA']) {
    lines.push(`- ${k}: ${total.exits[k]}`);
  }
  lines.push('');
  lines.push('By age at entry:');
  for (const [k, v] of Object.entries(total.by_age).sort()) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('By peak after entry:');
  const order = ['peak<=0%', 'peak[0-25%]', 'peak[25-75%]', 'peak[75-200%]', 'peak>200%'];
  for (const k of order) if (total.by_peak[k]) lines.push(`- ${k}: ${total.by_peak[k]}`);
  lines.push('');
  lines.push('Migrated to Raydium/Meteora/Orca?');
  const yes = total.migrated.yes;
  const no = total.migrated.no;
  const totalMig = yes + no;
  lines.push(`- migrated: ${yes} (${totalMig ? ((yes / totalMig) * 100).toFixed(1) : 0}%) avg_pnl=${fmtPct(yes ? total.migrated.sum_pnl_yes / yes : 0)}`);
  lines.push(`- not migrated: ${no} (${totalMig ? ((no / totalMig) * 100).toFixed(1) : 0}%) avg_pnl=${fmtPct(no ? total.migrated.sum_pnl_no / no : 0)}`);

  console.log(lines.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
