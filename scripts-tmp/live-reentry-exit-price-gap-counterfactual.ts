/**
 * Контрфактуал: пропускать повторный вход по mint, если первая нога входа не ниже
 * последнего рыночного выхода минимум на X% (как LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT).
 *
 * Источник: live JSONL (`live_position_open` + `live_position_close`), realized net из closedTrade.
 *
 *   npx tsx scripts-tmp/live-reentry-exit-price-gap-counterfactual.ts \
 *     --jsonl data/live/pt1-oscar-live.jsonl \
 *     --mints MINT1,MINT2 \
 *     --thresholds 0,5,10
 */
import fs from 'node:fs';
import readline from 'node:readline';

type Session = {
  mint: string;
  symbol: string;
  entryTs: number;
  exitTs: number;
  netUsd: number;
  entryFirstMarket: number;
  exitMarket: number;
  exitReason: string;
};

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function firstLegMarketFromOpenTrade(ot: Record<string, unknown>): number {
  const legs = ot.legs as Record<string, unknown>[] | undefined;
  if (Array.isArray(legs) && legs.length > 0) {
    const sorted = [...legs].sort((a, b) => num(a.ts) - num(b.ts));
    const m = num(sorted[0]!.marketPrice);
    if (m > 0) return m;
    return num(sorted[0]!.price);
  }
  return num(ot.avgEntryMarket) || num(ot.avgEntry);
}

function exitMarketFromClosed(ct: Record<string, unknown>): number {
  const t = num(ct.theoretical_exit_price);
  if (t > 0) return t;
  return num(ct.exitMcUsd) || num(ct.effective_exit_price);
}

async function scanSessions(jsonlPath: string, mintFilter: Set<string>): Promise<Session[]> {
  const pending = new Map<string, Record<string, unknown>>();
  const out: Session[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = String(e.kind ?? '');
    const mint = String(e.mint ?? '');
    if (!mint || (mintFilter.size > 0 && !mintFilter.has(mint))) continue;

    if (kind === 'live_position_open') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (ot) pending.set(mint, ot);
      continue;
    }
    if (
      kind === 'live_position_scale_in' ||
      kind === 'live_position_dca' ||
      kind === 'live_position_partial_sell'
    ) {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (ot) pending.set(mint, ot);
      continue;
    }
    if (kind === 'live_position_close') {
      const ct = e.closedTrade as Record<string, unknown> | undefined;
      if (!ct) {
        pending.delete(mint);
        continue;
      }
      const ot = pending.get(mint) ?? ct;
      pending.delete(mint);
      const exitTs = num(ct.exitTs);
      const entryTs = num(ot.entryTs ?? ct.entryTs);
      out.push({
        mint,
        symbol: String(ct.symbol ?? ''),
        entryTs,
        exitTs,
        netUsd: num(ct.netPnlUsd),
        entryFirstMarket: firstLegMarketFromOpenTrade(ot),
        exitMarket: exitMarketFromClosed(ct),
        exitReason: String(ct.exitReason ?? ''),
      });
    }
  }
  return out;
}

function simulate(
  sessions: Session[],
  minDropPct: number,
): { kept: Session[]; skipped: Session[]; totalNet: number } {
  const sorted = [...sessions].sort((a, b) => a.exitTs - b.exitTs);
  const kept: Session[] = [];
  const skipped: Session[] = [];
  let lastExitMarket: number | null = null;
  let totalNet = 0;
  const thr = minDropPct / 100;

  for (const s of sorted) {
    let allow = true;
    if (lastExitMarket != null && lastExitMarket > 0 && s.entryFirstMarket > 0 && minDropPct > 0) {
      const maxAllowed = lastExitMarket * (1 - thr);
      if (s.entryFirstMarket > maxAllowed * (1 + 1e-12)) allow = false;
    }
    if (allow) {
      kept.push(s);
      totalNet += s.netUsd;
      if (s.exitMarket > 0) lastExitMarket = s.exitMarket;
      else lastExitMarket = lastExitMarket;
    } else {
      skipped.push(s);
    }
  }
  return { kept, skipped, totalNet };
}

function parseCsvArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return def;
}

async function main(): Promise<void> {
  const jsonlPath = parseCsvArg('--jsonl', 'data/live/pt1-oscar-live.jsonl');
  const mintsRaw = parseCsvArg(
    '--mints',
    '2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y,CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump',
  );
  const thrRaw = parseCsvArg('--thresholds', '0,5,10');
  const mintFilter = new Set(mintsRaw.split(',').map((m) => m.trim()).filter(Boolean));
  const thresholds = thrRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);

  if (!fs.existsSync(jsonlPath)) {
    console.error(JSON.stringify({ error: 'jsonl_not_found', jsonlPath }));
    process.exit(1);
  }

  const all = await scanSessions(jsonlPath, mintFilter);
  const byMint = new Map<string, Session[]>();
  for (const s of all) {
    const arr = byMint.get(s.mint) ?? [];
    arr.push(s);
    byMint.set(s.mint, arr);
  }

  const report: Record<string, unknown> = {
    jsonlPath,
    mintsRequested: [...mintFilter],
    thresholdsPct: thresholds,
    rows: [] as Record<string, unknown>[],
  };

  for (const mint of mintFilter) {
    const sessions = (byMint.get(mint) ?? []).sort((a, b) => a.exitTs - b.exitTs);
    const symbol = sessions[0]?.symbol ?? '';
    const baseline = sessions.reduce((s, x) => s + x.netUsd, 0);
    const row: Record<string, unknown> = {
      mint,
      symbol,
      sessions: sessions.length,
      baselineNetUsd: +baseline.toFixed(6),
      byThreshold: {} as Record<string, number>,
      detailFirstVsPrevExit: sessions.map((s, i) => {
        const prev = i > 0 ? sessions[i - 1] : null;
        /** Положительно = новый вход дешевле последнего выхода (скидка к прошлому exit). */
        const discountVsPrevExitPct =
          prev && prev.exitMarket > 0 && s.entryFirstMarket > 0
            ? +(((prev.exitMarket - s.entryFirstMarket) / prev.exitMarket) * 100).toFixed(4)
            : null;
        return {
          i,
          entryTs: s.entryTs,
          exitTs: s.exitTs,
          exitReason: s.exitReason,
          entryFirstMarket: s.entryFirstMarket,
          prevExitMarket: prev?.exitMarket ?? null,
          discountVsPrevExitPct,
          netUsd: +s.netUsd.toFixed(4),
        };
      }),
    };

    const byTh: Record<string, { netUsd: number; kept: number; skipped: number }> = {};
    for (const th of thresholds) {
      const { totalNet, skipped, kept } = simulate(sessions, th);
      byTh[String(th)] = {
        netUsd: +totalNet.toFixed(6),
        kept: kept.length,
        skipped: skipped.length,
      };
    }
    (row as Record<string, unknown>).byThreshold = byTh;
    (report.rows as Record<string, unknown>[]).push(row);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
