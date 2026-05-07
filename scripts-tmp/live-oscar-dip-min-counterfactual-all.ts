/**
 * Live Oscar — контрфактуалы по всем `live_position_close` в JSONL.
 *
 * Модель: только **классический** dip OR(120/360/720 мин) + recovery veto (30/60 мин, bounce < 12%),
 * как в prod. **Impulse / pg-snap bypass не моделируется** — если классический gate на минуте входа
 * по PG не проходит, считаем, что без bypass сделки бы не было.
 *
 * Сценарий A — «убрали только bypass»: фактический порог глубины дипа **PAPER_DIP_MIN_DROP_PCT = −15**
 * (как раньше на live-oscar / paper-oscar), **PAPER_DIP_MAX_DROP_PCT = −50**.
 *
 * Сценарий B — без bypass и с **dip min = −30%** вместо −15 (ужесточение), max −50.
 *
 * Сценарий C — гипотеза **`PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP=1`** при текущем dip min **−30%**:
 * вход разрешён, если классический gate прошёл **или** сработал PG-триггер как в
 * `impulsePgSnapTriggerOk` (два последних снимка **по паре**, Δ ≤ −12%, возраст снимка 10–120 с);
 * **без** QN/Jupiter (полный impulse confirm в executor не воспроизводится).
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

/** Фактический порог по вашей постановке для закрытых сделок (исторический live-oscar до смены). */
const DIP_MIN_FACTUAL_NEG15 = -15;
/** Ужесточённый порог (текущий live-oscar в ecosystem). */
const DIP_MIN_STRICT_NEG30 = -30;
const DIP_MAX_DROP_NEG50 = -50;

/** Как у live-oscar в ecosystem (`PAPER_IMPULSE_PG_*`). */
const IMPULSE_PG_MIN_DROP_PCT = 12;
const IMPULSE_PG_MAX_AGE_SEC_MIN = 10;
const IMPULSE_PG_MAX_AGE_SEC_MAX = 120;
const IMPULSE_PG_ABS_MODE = false;

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
  pairAddress: string | null;
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

/** Два последних снимка по mint+pair с ts ≤ decisionTs (как бы выглядел запрос в момент входа). */
async function fetchLastTwoPairSnapshotsBefore(
  mint: string,
  dex: string,
  pairAddress: string,
  decisionTsMs: number,
): Promise<Array<{ tsMs: number; priceUsd: number }> | null> {
  const pair = String(pairAddress).trim();
  if (!pair) return null;
  const src = dex.toLowerCase().trim();
  const table = TABLES[src] ?? TABLES.pumpswap!;
  const t = quoteSqlIdent(table);
  const mintEsc = sqlQuoteMint(mint);
  const pairEsc = sqlQuoteMint(pair);
  const endSec = (decisionTsMs / 1000).toFixed(3);

  const raw = await db.execute(dsql.raw(`
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
           COALESCE(price_usd, 0)::float AS price_usd
    FROM ${t}
    WHERE base_mint = ${mintEsc}
      AND pair_address = ${pairEsc}
      AND ts <= to_timestamp(${endSec}) AT TIME ZONE 'UTC'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts DESC
    LIMIT 2
  `));

  const rows = raw as unknown as Array<{ ts_ms: string | bigint; price_usd: number }>;
  if (!Array.isArray(rows) || rows.length < 2) return null;

  return rows.map((r) => ({
    tsMs: typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms),
    priceUsd: r.price_usd,
  }));
}

/** Реплика `impulsePgSnapTriggerOk` на историческом entryTs (kill-switch не учитывается). */
function impulsePgSnapTriggerOkReplay(
  entryTsMs: number,
  snaps: Array<{ tsMs: number; priceUsd: number }>,
): boolean {
  const sNew = snaps[0]!;
  const sPrev = snaps[1]!;
  const pNew = sNew.priceUsd;
  const pPrev = sPrev.priceUsd;
  if (!(pPrev > 0) || !(pNew > 0)) return false;
  const ageSec = (entryTsMs - sNew.tsMs) / 1000;
  if (ageSec < IMPULSE_PG_MAX_AGE_SEC_MIN || ageSec > IMPULSE_PG_MAX_AGE_SEC_MAX) return false;
  const deltaPgPct = ((pNew - pPrev) / pPrev) * 100;
  return IMPULSE_PG_ABS_MODE
    ? Math.abs(deltaPgPct) >= IMPULSE_PG_MIN_DROP_PCT
    : deltaPgPct <= -IMPULSE_PG_MIN_DROP_PCT;
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
    const pairRaw = ct.pairAddress;
    const pairAddress =
      pairRaw != null && String(pairRaw).trim() ? String(pairRaw).trim() : null;
    if (!mint || !(entryTs > 0) || typeof net !== 'number') continue;
    closes.push({ mint, entryTs, netPnlUsd: net, dex, pairAddress });
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

  type Agg = { sumNet: number; nPass: number; bypassSum: number; nBypass: number };
  const mkAgg = (): Agg => ({ sumNet: 0, nPass: 0, bypassSum: 0, nBypass: 0 });

  const scenA = mkAgg(); // classical, dip min -15
  const scenB = mkAgg(); // classical, dip min -30

  let permitClassicalOrImpulse_n = 0;
  let permitClassicalOrImpulse_sum = 0;
  let marginalImpulseOnly_n = 0;
  let marginalImpulseOnly_sum = 0;
  let failBoth_n = 0;
  let failBoth_sum = 0;
  let impulseReplaySkippedNoPair = 0;

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

      const pass15 = passesGateAtEntry(snapPx, tsMs, px, idx, DIP_MIN_FACTUAL_NEG15, DIP_MAX_DROP_NEG50);
      const pass30 = passesGateAtEntry(snapPx, tsMs, px, idx, DIP_MIN_STRICT_NEG30, DIP_MAX_DROP_NEG50);

      let impulsePgOk = false;
      if (c.pairAddress) {
        const pairSnaps = await fetchLastTwoPairSnapshotsBefore(c.mint, c.dex, c.pairAddress, c.entryTs);
        impulsePgOk = pairSnaps ? impulsePgSnapTriggerOkReplay(c.entryTs, pairSnaps) : false;
      } else {
        impulseReplaySkippedNoPair++;
      }

      const permitHypotheticalBypass = pass30.pass || impulsePgOk;
      if (permitHypotheticalBypass) {
        permitClassicalOrImpulse_n++;
        permitClassicalOrImpulse_sum += c.netPnlUsd;
      }
      if (!pass30.pass && impulsePgOk) {
        marginalImpulseOnly_n++;
        marginalImpulseOnly_sum += c.netPnlUsd;
      }
      if (!pass30.pass && !impulsePgOk) {
        failBoth_n++;
        failBoth_sum += c.netPnlUsd;
      }

      if (pass15.pass) {
        scenA.sumNet += c.netPnlUsd;
        scenA.nPass++;
      } else {
        scenA.bypassSum += c.netPnlUsd;
        scenA.nBypass++;
      }

      if (pass30.pass) {
        scenB.sumNet += c.netPnlUsd;
        scenB.nPass++;
      } else {
        scenB.bypassSum += c.netPnlUsd;
        scenB.nBypass++;
      }
    }
  }

  const evaluatedCloses = scenA.nPass + scenA.nBypass;
  const fmt = (x: number) => +x.toFixed(6);

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        closesInJournal: nCloses,
        closesEvaluatedWithSnapshots: evaluatedCloses,
        uniqueMintDexGroups: byMintDex.size,
        actualAllClosedTrades: {
          count: nCloses,
          sumNetPnlUsd: fmt(actualSum),
        },

        scenarioA_removeImpulseOnly_factualDipMinNeg15: {
          meaning:
            'Только классический gate; порог глубины дипа как при −15% (исторический режим). Сделки без прохода gate — те, что в live появились бы только через impulse/pg-snap (или расхождение PG vs live).',
          dipMinDropPct: DIP_MIN_FACTUAL_NEG15,
          dipMaxDropPct: DIP_MAX_DROP_NEG50,
          tradesWouldOccurWithoutBypass: scenA.nPass,
          tradesFewerVsAllJournalCloses: nCloses - scenA.nPass,
          pctFewerVsAllJournalCloses: fmt(((nCloses - scenA.nPass) / Math.max(nCloses, 1)) * 100),
          tradesAttributedToImpulseOrMismatch: scenA.nBypass,
          sumNetPnlUsd_of_classicalOnlySubset: fmt(scenA.sumNet),
          sumNetPnlUsd_of_bypassSubset_observed: fmt(scenA.bypassSum),
          deltaVsActualSum_ifReplaceTotalWithClassicalSubset: fmt(scenA.sumNet - actualSum),
        },

        scenarioB_noImpulse_dipMinNeg30: {
          meaning:
            'Тот же классический gate, но минимальная глубина дипа −30% вместо −15% (ужесточение).',
          dipMinDropPct: DIP_MIN_STRICT_NEG30,
          dipMaxDropPct: DIP_MAX_DROP_NEG50,
          tradesWouldOccurWithoutBypass: scenB.nPass,
          tradesFewerVsAllJournalCloses: nCloses - scenB.nPass,
          pctFewerVsAllJournalCloses: fmt(((nCloses - scenB.nPass) / Math.max(nCloses, 1)) * 100),
          tradesAttributedToImpulseOrMismatch: scenB.nBypass,
          sumNetPnlUsd_of_classicalOnlySubset: fmt(scenB.sumNet),
          sumNetPnlUsd_of_bypassSubset_observed: fmt(scenB.bypassSum),
          deltaVsActualSum_ifReplaceTotalWithClassicalSubset: fmt(scenB.sumNet - actualSum),
        },

        effect_of_tightening_dip_min_from_15_to_30_classicalOnly: {
          meaning:
            'Разница между сценарием A и B: сколько «лишних» входов давал более мягкий −15% при том же классическом пути.',
          extraTradesAllowedByDipMinNeg15vsNeg30: scenA.nPass - scenB.nPass,
          deltaSumNetPnlUsd_classicalSubset_A_minus_B: fmt(scenA.sumNet - scenB.sumNet),
        },

        scenarioC_hypothetical_ENTRY_IMPULSE_PG_BYPASS_DIP_enabled_dipMinNeg30: {
          meaning:
            'Если бы включили обход dip по PG-импульсу (как в dip-clones при entryImpulsePgBypassesDip): вход разрешён при классическом gate ИЛИ PG Δ; ниже только триггер двух снимков по pair, без QN/Jupiter.',
          dipMinDropPct: DIP_MIN_STRICT_NEG30,
          impulsePgMinDropPct: IMPULSE_PG_MIN_DROP_PCT,
          impulsePgSnapAgeSecRange: [IMPULSE_PG_MAX_AGE_SEC_MIN, IMPULSE_PG_MAX_AGE_SEC_MAX],
          classicalOnly_passCount: scenB.nPass,
          classicalOnly_sumNetPnlUsd: fmt(scenB.sumNet),
          permit_classical_OR_impulsePgSnap_passCount: permitClassicalOrImpulse_n,
          permit_classical_OR_impulsePgSnap_sumNetPnlUsd: fmt(permitClassicalOrImpulse_sum),
          extraTradesVsClassicalOnly_fromImpulsePgSnap: marginalImpulseOnly_n,
          extraSumNetPnlUsd_marginalImpulseOnly: fmt(marginalImpulseOnly_sum),
          tradesFailClassicalAndFailImpulsePgReplay_count: failBoth_n,
          tradesFailClassicalAndFailImpulsePgReplay_sumNetPnlUsd_observed: fmt(failBoth_sum),
          closesMissingPairAddress_impulseSkipped: impulseReplaySkippedNoPair,
        },

        closesWithoutUsableSnapshots: noSnap,
        notes: [
          'Naive backtest: суммируется исторический net сделок, прошедших gate; scenario C — только PG-часть impulse, без QN/Jupiter.',
          'Если closesEvaluatedWithSnapshots < closesInJournal — часть строк не попала в расчёт из‑за отсутствия PG ряда.',
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
