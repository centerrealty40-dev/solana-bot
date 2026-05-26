/**
 * Live Oscar — **только факты из журнала** (`live_position_close`), без Postgres и без симуляции.
 *
 * Для каждой закрытой сделки берутся те поля, которые бот уже записал после реальных свопов:
 * средняя цена входа, рыночная цена на выходе, net PnL, причина выхода, пик PnL за жизнь позиции (если есть exitContext).
 *
 *   npx tsx scripts/live-oscar-journal-facts-report.ts --journal data/live/pt1-oscar-live.jsonl
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

type ExitCtx = {
  peakPnlPct?: number;
  closePnlPct?: number;
  triggerLabel?: string;
};

type Row = {
  mint: string;
  symbol: string;
  exitReason: string;
  netPnlUsd: number;
  pnlPct: number;
  avgEntry: number;
  /** Рыночная цена токена USD, как записал трекер на выходе (до/параллельно costs). */
  theoreticalExitUsd: number;
  effectiveExitUsd: number;
  /** (theoreticalExit / avgEntry - 1) * 100 для metricType price; иначе null. */
  rawExitMovePctVsAvg: number | null;
  peakPnlPct: number | null;
  entryTs: number;
  exitTs: number;
};

async function main(): Promise<void> {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const abs = path.resolve(journal);
  if (!fs.existsSync(abs)) {
    console.error('journal missing', abs);
    process.exit(1);
  }

  const rows: Row[] = [];
  let skipped = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim() || line[0] !== '{') continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    if (e.kind !== 'live_position_close') continue;
    if (typeof e.strategyId === 'string' && e.strategyId !== 'live-oscar') continue;
    const ct = e.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct.mint !== 'string') continue;

    const avgEntry = num(ct.avgEntry);
    const thExit = num(ct.theoretical_exit_price);
    const effExit = num(ct.effective_exit_price);
    const net = num(ct.netPnlUsd);
    const pnlPct = num(ct.pnlPct);
    const entryTs = num(ct.entryTs);
    const exitTs = num(ct.exitTs);
    const metricType = typeof ct.metricType === 'string' ? ct.metricType : '';
    const exitReason = typeof ct.exitReason === 'string' ? ct.exitReason : 'UNKNOWN';

    if (!Number.isFinite(net) || Math.abs(net) > 1e7) {
      skipped++;
      continue;
    }

    let rawMove: number | null = null;
    if (metricType === 'price' && avgEntry > 0 && thExit > 0) {
      rawMove = (thExit / avgEntry - 1) * 100;
    }

    const xc = ct.exitContext as ExitCtx | undefined;
    const peakPnlPct =
      xc && typeof xc.peakPnlPct === 'number' && Number.isFinite(xc.peakPnlPct) ? xc.peakPnlPct : null;

    rows.push({
      mint: ct.mint as string,
      symbol: typeof ct.symbol === 'string' ? ct.symbol : '',
      exitReason,
      netPnlUsd: net,
      pnlPct,
      avgEntry,
      theoreticalExitUsd: thExit,
      effectiveExitUsd: effExit,
      rawExitMovePctVsAvg: rawMove,
      peakPnlPct,
      entryTs,
      exitTs,
    });
  }

  const sumNet = rows.reduce((a, r) => a + r.netPnlUsd, 0);
  const byReason: Record<string, { n: number; sumNet: number }> = {};
  for (const r of rows) {
    if (!byReason[r.exitReason]) byReason[r.exitReason] = { n: 0, sumNet: 0 };
    byReason[r.exitReason]!.n++;
    byReason[r.exitReason]!.sumNet += r.netPnlUsd;
  }

  const peaks = rows.filter((r) => r.peakPnlPct != null) as Array<Row & { peakPnlPct: number }>;
  const wouldHaveSeen8Plus = rows.filter((r) => r.peakPnlPct != null && r.peakPnlPct >= 8).length;
  const closedGreen = rows.filter((r) => r.netPnlUsd > 0).length;
  const closedRed = rows.filter((r) => r.netPnlUsd < 0).length;

  console.log(
    JSON.stringify(
      {
        journal: abs,
        noteRu:
          'Это не «что если», а то, что бот уже записал в журнал после живых сделок: деньги (netPnlUsd) и цены выхода (theoretical_exit_price к avgEntry).',
        trades: rows.length,
        skippedLines: skipped,
        factJournal: {
          sumNetPnlUsd: +sumNet.toFixed(2),
          wins: closedGreen,
          losses: closedRed,
          breakeven: rows.length - closedGreen - closedRed,
        },
        exitReasonBreakdown: Object.fromEntries(
          Object.entries(byReason)
            .sort((a, b) => b[1].sumNet - a[1].sumNet)
            .map(([k, v]) => [k, { trades: v.n, sumNetPnlUsd: +v.sumNet.toFixed(2) }]),
        ),
        peakPnlFromExitContext: {
          tradesWithPeak: peaks.length,
          tradesWherePeakWasAtLeast8pct: wouldHaveSeen8Plus,
          noteRu:
            'peakPnlPct — максимум «по учёту трекера» за жизнь позиции; это не внешний оракул, но ближе к «куда цена ходила», чем сухая симуляция по PG.',
        },
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
