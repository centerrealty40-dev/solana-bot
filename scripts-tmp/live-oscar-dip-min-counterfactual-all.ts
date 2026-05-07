/**
 * Live Oscar — контрфактуалы по всем `live_position_close` в JSONL:
 *
 * 1) Только классический dip + recovery veto по PG-снимкам (как в prod evaluateDip /
 *    evaluateRecoveryVeto). Обход **impulse/pg-snap** не моделируется — если бы его не было,
 *    в реальности считалось бы только это; сделки, которые прошли бы только через bypass,
 *    дают расхождение с replay (см. bypassCandidates).
 *
 * 2) Отдельные прогоны **PAPER_DIP_MAX_DROP_PCT** = −15 и −30 при фиксированном
 *    **PAPER_DIP_MIN_DROP_PCT** = −30 (как сейчас на live-oscar). По коду: проход требует
 *    dipPct <= dip_min И dipPct >= dip_max (обе отрицательные); при min=−30 и max=−15
 *    допустимый интервал пуст — ожидайте 0 проходов.
 *
 * Run on VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts-tmp/live-oscar-dip-min-counterfactual-all.ts
 *
 * argv[2] — опциональный путь к JSONL.
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';

const DIP_WINDOWS_MIN = [120, 360, 720];
const RECOVERY_WINDOWS_MIN = [30, 60];
const DIP_MIN_IMPULSE_PCT = 12;
const RECOVERY_MAX_BOUNCE_PCT = 12;

/** Текущий live-oscar dip_min после последнего изменения ecosystem. */
const DIP_MIN_LIVE_OSCAR = -30;

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
  dipMaxDropPct: number,
): { ok: boolean; dipPct: number | null; impulsePct: number | null } {
  if (!(hi > 0)) return { ok: false, dipPct: null, impulsePct: null };
  const dipPct = (price / hi - 1) * 100;
  if (dipPct > dipMinDropPct) return { ok: false, dipPct, impulsePct: null };
  if (dipPct < dipMaxDropPct) return { ok: false, dipPct, impulsePct: null };
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
  dipMaxDropPct: number,
): { pass: boolean; usedW: number | null } {
  const ctx = new Map<number, [number, number]>();
  const allW = [...new Set([...DIP_WINDOWS_MIN, ...RECOVERY_WINDOWS_MIN])].sort((a, b) => a - b);
  for (const w of allW) {
    ctx.set(w, windowHighLow(tsMs, px, idx, w));
  }

  let usedW: number | null = null;
  for (const w of DIP_WINDOWS_MIN) {
    const [hi, lo] = ctx.get(w)!;
    const { ok } = dipOneWindow(snapPx, hi, lo, dipMinDropPct, dipMaxDropPct);
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
  const nCloses = closes.length;

  const byMintDex = new Map<string, CloseEv[]>();
  for (const c of closes) {
    const k = `${c.mint}\t${c.dex}`;
    const arr = byMintDex.get(k) ?? [];
    arr.push(c);
    byMintDex.set(k, arr);
  }

  let noSnap = 0;

  type Agg = { sumNet: number; nPass: number };
  const mkAgg = (): Agg => ({ sumNet: 0, nPass: 0 });

  const classicalProd = mkAgg(); // min -30 max -50 (как ecosystem до экспериментов max)
  const classicalMax30 = mkAgg();
  const classicalMax15 = mkAgg();
  const replayMin15Max50 = mkAgg();

  let bypassCandidateSum = 0;
  let bypassCandidateCount = 0;

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

      const prodPass = passesGateAtEntry(snapPx, tsMs, px, idx, DIP_MIN_LIVE_OSCAR, -50);
      const max30Pass = passesGateAtEntry(snapPx, tsMs, px, idx, DIP_MIN_LIVE_OSCAR, -30);
      const max15Pass = passesGateAtEntry(snapPx, tsMs, px, idx, DIP_MIN_LIVE_OSCAR, -15);
      const min15Pass = passesGateAtEntry(snapPx, tsMs, px, idx, -15, -50);

      if (prodPass.pass) {
        classicalProd.sumNet += c.netPnlUsd;
        classicalProd.nPass++;
      } else {
        bypassCandidateSum += c.netPnlUsd;
        bypassCandidateCount++;
      }

      if (max30Pass.pass) {
        classicalMax30.sumNet += c.netPnlUsd;
        classicalMax30.nPass++;
      }
      if (max15Pass.pass) {
        classicalMax15.sumNet += c.netPnlUsd;
        classicalMax15.nPass++;
      }
      if (min15Pass.pass) {
        replayMin15Max50.sumNet += c.netPnlUsd;
        replayMin15Max50.nPass++;
      }
    }
  }

  const bandNote =
    'При dip_min=−30 и dip_max=−15 условие dipPct≤−30 и dipPct≥−15 одновременно невыполнимо — ожидается 0 проходов. При dip_max=−30 допускается только узкая полоса у −30% от high.';

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        closes: nCloses,
        uniqueMintDexGroups: byMintDex.size,
        actualTotalNetPnlUsd: +actualSum.toFixed(6),

        withoutImpulsePgSnap_world: {
          meaning:
            'Суммируем net только если на минуте входа проходит классический dip OR(120/360/720)+recovery veto; bypass impulse/pg-snap не считается.',
          dipMinDropPct: DIP_MIN_LIVE_OSCAR,
          dipMaxDropPct: -50,
          tradesPassingClassicalGate: classicalProd.nPass,
          tradesFewerVsAllCloses: nCloses - classicalProd.nPass,
          pctFewerTrades: +(((nCloses - classicalProd.nPass) / Math.max(nCloses, 1)) * 100).toFixed(1),
          sumNetPnlUsdIfOnlyClassical: +classicalProd.sumNet.toFixed(6),
          deltaVsActualUsd: +(classicalProd.sumNet - actualSum).toFixed(6),
        },

        bypassOrReplayMismatch: {
          meaning:
            'Закрытия, где классический gate (min−30 max−50) на PG-снимке не прошёл, но сделка в live была — типично bypass impulse/pg-snap или расхождение минуты PG vs live.',
          count: bypassCandidateCount,
          sumObservedNetPnlUsd: +bypassCandidateSum.toFixed(6),
        },

        dipMaxDropSensitivity_sameDipMinNeg30: {
          dipMinDropPct: DIP_MIN_LIVE_OSCAR,
          maxNeg50_baseline: {
            tradesPassing: classicalProd.nPass,
            sumNetPnlUsd: +classicalProd.sumNet.toFixed(6),
          },
          maxNeg30: {
            tradesPassing: classicalMax30.nPass,
            tradesFewerVsBaselineMax50: classicalProd.nPass - classicalMax30.nPass,
            sumNetPnlUsd: +classicalMax30.sumNet.toFixed(6),
            deltaVsBaselineUsd: +(classicalMax30.sumNet - classicalProd.sumNet).toFixed(6),
          },
          maxNeg15: {
            tradesPassing: classicalMax15.nPass,
            tradesFewerVsBaselineMax50: classicalProd.nPass - classicalMax15.nPass,
            sumNetPnlUsd: +classicalMax15.sumNet.toFixed(6),
            deltaVsBaselineUsd: +(classicalMax15.sumNet - classicalProd.sumNet).toFixed(6),
            bandNote,
          },
        },

        legacyReplay_dipMinNeg15_maxNeg50: {
          tradesPassing: replayMin15Max50.nPass,
          sumNetPnlUsd: +replayMin15Max50.sumNet.toFixed(6),
        },

        closesWithoutUsableSnapshots: noSnap,
        notes: [
          'PG snapshots ~1m; без симуляции impulse_pg_snap.',
          bandNote,
        ],
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
