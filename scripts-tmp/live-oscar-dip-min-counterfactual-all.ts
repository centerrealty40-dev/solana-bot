/**
 * Counterfactual: sum observed live-oscar closed-trade net PnL if dip gate used
 * PAPER_DIP_MIN_DROP_PCT = -30 vs -15 (other dip/recovery params fixed as in prod ecosystem).
 *
 * Policy: at each trade's entryTs, replay high/low windows from PG snapshots ending at that minute;
 * if gate FAILS at threshold, trade is treated as "would not enter" → $0 contribution.
 *
 * Run on host with DATABASE_URL + journal file (default live JSONL path):
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts-tmp/live-oscar-dip-min-counterfactual-all.ts
 *
 * Optional argv: path to JSONL (default ./data/live/pt1-oscar-live.jsonl relative to cwd).
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

const DIP_WINDOWS_MIN = [120, 360, 720];
const RECOVERY_WINDOWS_MIN = [30, 60];
const DIP_MAX_DROP_PCT = -50;
const DIP_MIN_IMPULSE_PCT = 12;
const DIP_MIN_AGE_MIN = 0;
const RECOVERY_MAX_BOUNCE_PCT = 12;

const TABLES: Record<string, string> = {
  pumpswap: 'pumpswap_pair_snapshots',
  raydium: 'raydium_pair_snapshots',
  orca: 'orca_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
};

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table: ${ident}`);
  return ident;
}

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface CloseEv {
  mint: string;
  entryTs: number;
  netPnlUsd: number;
  dex: string;
}

function bisectLeft(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function idxAtOrBefore(tsMs: number[], t: number): number {
  return bisectLeft(tsMs, t + 1) - 1;
}

function windowHighLow(tsMs: number[], px: number[], endIdx: number, winMin: number): [number, number] {
  const endT = tsMs[endIdx]!;
  const startT = endT - winMin * 60_000;
  const i0 = bisectLeft(tsMs, startT);
  let hi = 0;
  let lo = Number.POSITIVE_INFINITY;
  for (let j = i0; j <= endIdx; j++) {
    const p = px[j]!;
    if (p > hi) hi = p;
    if (p > 0 && p < lo) lo = p;
  }
  if (!Number.isFinite(lo)) lo = 0;
  return [hi, lo];
}

function dipOneWindow(
  price: number,
  hi: number,
  lo: number,
  dipMinDropPct: number,
): { ok: boolean; dipPct: number | null; impulsePct: number | null } {
  if (!(hi > 0)) return { ok: false, dipPct: null, impulsePct: null };
  const dipPct = (price / hi - 1) * 100;
  if (dipPct > dipMinDropPct) return { ok: false, dipPct, impulsePct: null };
  if (dipPct < DIP_MAX_DROP_PCT) return { ok: false, dipPct, impulsePct: null };
  const impulsePct = lo > 0 ? (hi / lo - 1) * 100 : null;
  if ((impulsePct ?? 0) < DIP_MIN_IMPULSE_PCT) return { ok: false, dipPct, impulsePct };
  return { ok: true, dipPct, impulsePct };
}

function passesGateAtEntry(
  snapPx: number,
  tsMs: number[],
  px: number[],
  idx: number,
  dipMinDropPct: number,
): { pass: boolean; usedW: number | null } {
  const ctx = new Map<number, [number, number]>();
  const allW = [...new Set([...DIP_WINDOWS_MIN, ...RECOVERY_WINDOWS_MIN])].sort((a, b) => a - b);
  for (const w of allW) {
    ctx.set(w, windowHighLow(tsMs, px, idx, w));
  }

  let usedW: number | null = null;
  for (const w of DIP_WINDOWS_MIN) {
    const [hi, lo] = ctx.get(w)!;
    const { ok } = dipOneWindow(snapPx, hi, lo, dipMinDropPct);
    if (ok) {
      usedW = w;
      break;
    }
  }
  if (usedW == null) return { pass: false, usedW: null };

  for (const v of RECOVERY_WINDOWS_MIN) {
    if (v >= usedW) continue;
    const [_hi, lo] = ctx.get(v)!;
    if (!(lo > 0)) continue;
    const bounce = (snapPx / lo - 1) * 100;
    if (bounce >= RECOVERY_MAX_BOUNCE_PCT) return { pass: false, usedW };
  }

  return { pass: true, usedW };
}

async function loadSnapshotsForMint(
  mint: string,
  dex: string,
  tMinMs: number,
  tMaxMs: number,
): Promise<{ tsMs: number[]; px: number[] } | null> {
  const src = dex.toLowerCase().trim();
  const table = TABLES[src] ?? TABLES.pumpswap!;
  const t = quoteSqlIdent(table);
  const mintEsc = sqlQuoteMint(mint);
  const fromSec = (tMinMs / 1000).toFixed(3);
  const toSec = (tMaxMs / 1000).toFixed(3);

  const raw = await db.execute(dsql.raw(`
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
           COALESCE(price_usd, 0)::float AS price_usd
    FROM ${t}
    WHERE base_mint = ${mintEsc}
      AND ts >= to_timestamp(${fromSec}) AT TIME ZONE 'UTC'
      AND ts <= to_timestamp(${toSec}) AT TIME ZONE 'UTC'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `));

  const rows = raw as unknown as Array<{ ts_ms: string | bigint; price_usd: number }>;
  if (!rows.length) return null;

  const tsMs: number[] = [];
  const px: number[] = [];
  for (const r of rows) {
    const ts = typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms);
    tsMs.push(ts);
    px.push(r.price_usd);
  }
  return { tsMs, px };
}

async function main(): Promise<void> {
  const jsonlPath =
    process.argv[2]?.trim() ||
    path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  const closes: CloseEv[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.kind !== 'live_position_close') continue;
    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct) continue;
    const mint = String(ct.mint ?? '');
    const entryTs = Number(ct.entryTs ?? 0);
    const net = ct.netPnlUsd;
    let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
    if (!TABLES[dex]) dex = 'pumpswap';
    if (!mint || !(entryTs > 0) || typeof net !== 'number') continue;
    closes.push({ mint, entryTs, netPnlUsd: net, dex });
  }

  const actualSum = closes.reduce((a, c) => a + c.netPnlUsd, 0);

  const byMintDex = new Map<string, CloseEv[]>();
  for (const c of closes) {
    const k = `${c.mint}\t${c.dex}`;
    const arr = byMintDex.get(k) ?? [];
    arr.push(c);
    byMintDex.set(k, arr);
  }

  let sumIfMinus15 = 0;
  let sumIfMinus30 = 0;
  let nPass15 = 0;
  let nPass30 = 0;
  let noSnap = 0;

  for (const [, arr] of byMintDex) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    const mint = arr[0]!.mint;
    const dex = arr[0]!.dex;
    const tMin = Math.min(...arr.map((x) => x.entryTs)) - (720 + 1440) * 60_000;
    const tMax = Math.max(...arr.map((x) => x.entryTs)) + 120_000;

    const series = await loadSnapshotsForMint(mint, dex, tMin, tMax);
    if (!series) {
      noSnap += arr.length;
      continue;
    }
    const { tsMs, px } = series;

    for (const c of arr) {
      const idx = idxAtOrBefore(tsMs, c.entryTs);
      if (idx < 0) {
        noSnap++;
        continue;
      }
      const snapPx = px[idx]!;
      const p15 = passesGateAtEntry(snapPx, tsMs, px, idx, -15);
      const p30 = passesGateAtEntry(snapPx, tsMs, px, idx, -30);
      if (p15.pass) {
        sumIfMinus15 += c.netPnlUsd;
        nPass15++;
      }
      if (p30.pass) {
        sumIfMinus30 += c.netPnlUsd;
        nPass30++;
      }
    }
  }

  const skippedActualPnl = actualSum - sumIfMinus30;
  const deltaVsActual = sumIfMinus30 - actualSum;

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        closes: closes.length,
        uniqueMintDexGroups: byMintDex.size,
        actualTotalNetPnlUsd: +actualSum.toFixed(6),
        replayTotalIfDipMinNeg15Usd: +sumIfMinus15.toFixed(6),
        replayTradesPassingNeg15: nPass15,
        counterfactualTotalIfDipMinNeg30Usd: +sumIfMinus30.toFixed(6),
        counterfactualTradesPassingNeg30: nPass30,
        deltaCounterfactualMinusActualUsd: +deltaVsActual.toFixed(6),
        impliedSkippedTradesPnlUsd: +skippedActualPnl.toFixed(6),
        closesWithoutUsableSnapshots: noSnap,
        note:
          'Replay uses PG snapshots only (same dex table as closedTrade.dex); impulse_pg_snap bypass not modeled. Timestamps align to snapshot cadence (~1m).',
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
