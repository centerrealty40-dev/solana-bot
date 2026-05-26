/**
 * Диагностика: сравнение закрытых сделок Live Oscar vs Live Oscar Risky vs Paper Oscar Risky.
 *
 * Источники фактов — только JSONL (закрытия), опционально whitelist mint.
 *
 * Usage:
 *   npx tsx scripts-tmp/diag-oscar-triple-strategy-compare.ts \
 *     --live data/live/pt1-oscar-live.jsonl \
 *     --live-risky data/live/pt1-oscar-live-risky.jsonl \
 *     --paper data/paper2/paper-oscar-risky.jsonl \
 *     --whitelist data/live/live-oscar-mint-whitelist.txt \
 *     --match-window-ms 86400000 \
 *     --out data/live/diag-oscar-triple-compare.json
 *
 * Optional time filter (exit time):
 *   --since-ms 0 --until-ms 9999999999999
 *
 * Если файл отсутствует — стратегия пропускается (counts=0).
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

type StrategyKey = 'liveOscar' | 'liveOscarRisky' | 'paperOscarRisky';

type CloseRow = {
  strategyKey: StrategyKey;
  strategyId: string;
  mint: string;
  symbol: string;
  entryTs: number;
  exitTs: number;
  netPnlUsd: number;
  grossPnlUsd: number | null;
  totalInvestedUsd: number;
  pnlPct: number;
  exitReason: string;
  entryLiqUsd: number | null;
  source: string | null;
  lane: string | null;
  dex: string | null;
  legs: number;
  dcaLegs: number;
  feeCostUsd: number | null;
  slipCostUsd: number | null;
  networkCostUsd: number | null;
};

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function loadWhitelist(abs: string): Set<string> {
  const s = new Set<string>();
  if (!abs || !fs.existsSync(abs)) return s;
  const body = fs.readFileSync(abs, 'utf-8');
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (cut) s.add(cut);
  }
  return s;
}

function num(x: unknown, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function extractCosts(ct: Record<string, unknown>): {
  feeCostUsd: number | null;
  slipCostUsd: number | null;
  networkCostUsd: number | null;
  grossPnlUsd: number | null;
} {
  const c = ct.costs as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object')
    return { feeCostUsd: null, slipCostUsd: null, networkCostUsd: null, grossPnlUsd: null };
  return {
    feeCostUsd: num(c.fee_cost_usd, NaN) || null,
    slipCostUsd: num(c.slippage_cost_usd, NaN) || null,
    networkCostUsd: num(c.network_cost_usd, NaN) || null,
    grossPnlUsd: num(c.gross_pnl_usd, NaN) || null,
  };
}

function rowFromClosedTrade(strategyKey: StrategyKey, strategyId: string, ct: Record<string, unknown>): CloseRow | null {
  const mint = typeof ct.mint === 'string' ? ct.mint : '';
  if (!mint) return null;
  const legs = Array.isArray(ct.legs) ? ct.legs.length : 0;
  const dcaLegs = Array.isArray(ct.legs) ? ct.legs.filter((l) => (l as { reason?: string }).reason === 'dca').length : 0;
  const costs = extractCosts(ct);
  const gross =
    costs.grossPnlUsd != null && Number.isFinite(costs.grossPnlUsd)
      ? costs.grossPnlUsd
      : typeof ct.grossPnlUsd === 'number'
        ? ct.grossPnlUsd
        : null;
  return {
    strategyKey,
    strategyId,
    mint,
    symbol: String(ct.symbol ?? ''),
    entryTs: num(ct.entryTs),
    exitTs: num(ct.exitTs),
    netPnlUsd: num(ct.netPnlUsd),
    grossPnlUsd: gross,
    totalInvestedUsd: num(ct.totalInvestedUsd),
    pnlPct: num(ct.pnlPct),
    exitReason: String(ct.exitReason ?? ''),
    entryLiqUsd: ct.entryLiqUsd != null ? num(ct.entryLiqUsd) : null,
    source: ct.source != null ? String(ct.source) : null,
    lane: ct.lane != null ? String(ct.lane) : null,
    dex: ct.dex != null ? String(ct.dex) : null,
    legs,
    dcaLegs,
    feeCostUsd: costs.feeCostUsd,
    slipCostUsd: costs.slipCostUsd,
    networkCostUsd: costs.networkCostUsd,
  };
}

async function loadClosesFromJournal(
  filePath: string | undefined,
  strategyKey: StrategyKey,
  mode: 'paper_flat_close' | 'live_nested_close',
): Promise<CloseRow[]> {
  const out: CloseRow[] = [];
  if (!filePath) return out;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim() || line[0] !== '{') continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = String(j.kind ?? '');
    if (mode === 'live_nested_close') {
      if (kind !== 'live_position_close') continue;
      const ct = j.closedTrade as Record<string, unknown> | undefined;
      if (!ct || typeof ct !== 'object') continue;
      const sid = String(j.strategyId ?? '');
      const r = rowFromClosedTrade(strategyKey, sid, ct);
      if (r) out.push(r);
    } else {
      if (kind !== 'close') continue;
      const sid = String(j.strategyId ?? '');
      const r = rowFromClosedTrade(strategyKey, sid, j);
      if (r) out.push(r);
    }
  }
  return out;
}

function filterByExitWindow(rows: CloseRow[], sinceMs: number, untilMs: number): CloseRow[] {
  return rows.filter((r) => r.exitTs >= sinceMs && r.exitTs <= untilMs);
}

/** Синтетические закрытия в live-журнале (без реального трейда для сравнения PnL). */
const NON_ECONOMIC_EXIT_REASONS = new Set(['PERIODIC_HEAL']);

const ABSURD_USD = 1e7; // выше — считаем битой сериализацией/единицами, не трейдом

function isEconomicCloseRow(r: CloseRow): boolean {
  if (NON_ECONOMIC_EXIT_REASONS.has(r.exitReason)) return false;
  if (!Number.isFinite(r.netPnlUsd) || Math.abs(r.netPnlUsd) > ABSURD_USD) return false;
  if (!Number.isFinite(r.totalInvestedUsd) || r.totalInvestedUsd < 0 || r.totalInvestedUsd > ABSURD_USD) return false;
  return true;
}

function exclusionStats(before: CloseRow[], economicRows: CloseRow[]) {
  const keep = new Set(economicRows);
  const excluded = before.filter((r) => !keep.has(r));
  const byReason: Record<string, number> = {};
  for (const r of excluded) {
    const k = r.exitReason || 'UNKNOWN';
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  return { excludedCount: excluded.length, excludedByExitReason: byReason };
}

function liqBucket(liq: number | null): string {
  if (liq == null || !Number.isFinite(liq) || liq <= 0) return 'unknown';
  if (liq < 100_000) return 'liq_<100k';
  if (liq < 150_000) return 'liq_100k_150k';
  if (liq < 300_000) return 'liq_150k_300k';
  return 'liq_300k_plus';
}

function summarize(rows: CloseRow[], whitelist: Set<string>) {
  const n = rows.length;
  const sumNet = rows.reduce((s, r) => s + r.netPnlUsd, 0);
  const sumInvested = rows.reduce((s, r) => s + r.totalInvestedUsd, 0);
  const wins = rows.filter((r) => r.netPnlUsd > 1e-9).length;
  const losses = rows.filter((r) => r.netPnlUsd < -1e-9).length;
  const flat = n - wins - losses;
  const byExit: Record<string, { count: number; sumNet: number }> = {};
  for (const r of rows) {
    const k = r.exitReason || 'UNKNOWN';
    byExit[k] = byExit[k] || { count: 0, sumNet: 0 };
    byExit[k]!.count++;
    byExit[k]!.sumNet += r.netPnlUsd;
  }
  const byLiq: Record<string, { count: number; sumNet: number; sumInvested: number }> = {};
  for (const r of rows) {
    const b = liqBucket(r.entryLiqUsd);
    byLiq[b] = byLiq[b] || { count: 0, sumNet: 0, sumInvested: 0 };
    byLiq[b]!.count++;
    byLiq[b]!.sumNet += r.netPnlUsd;
    byLiq[b]!.sumInvested += r.totalInvestedUsd;
  }
  let feeSum = 0;
  let slipSum = 0;
  let netMinusGross = 0;
  let withCosts = 0;
  for (const r of rows) {
    if (r.feeCostUsd != null && Number.isFinite(r.feeCostUsd)) {
      withCosts++;
      feeSum += r.feeCostUsd;
    }
    if (r.slipCostUsd != null && Number.isFinite(r.slipCostUsd)) slipSum += r.slipCostUsd;
    if (r.grossPnlUsd != null && Number.isFinite(r.grossPnlUsd)) netMinusGross += r.netPnlUsd - r.grossPnlUsd;
  }
  let wlCount = 0;
  let wlSumNet = 0;
  let nonWlCount = 0;
  let nonWlSumNet = 0;
  for (const r of rows) {
    if (whitelist.size === 0) break;
    if (whitelist.has(r.mint)) {
      wlCount++;
      wlSumNet += r.netPnlUsd;
    } else {
      nonWlCount++;
      nonWlSumNet += r.netPnlUsd;
    }
  }
  const medNet = (() => {
    if (!n) return null;
    const s = [...rows].map((r) => r.netPnlUsd).sort((a, b) => a - b);
    return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  })();
  return {
    closes: n,
    sumNetPnlUsd: +sumNet.toFixed(4),
    sumInvestedUsd: +sumInvested.toFixed(4),
    roiOnInvested: sumInvested > 0 ? +((sumNet / sumInvested) * 100).toFixed(4) : null,
    medianNetPnlUsd: medNet != null ? +medNet.toFixed(6) : null,
    wins,
    losses,
    flat,
    byExitReason: byExit,
    byEntryLiqBucket: byLiq,
    costs: {
      rowsWithFeeField: withCosts,
      sumFeeCostUsd: +feeSum.toFixed(4),
      sumSlippageCostUsd: +slipSum.toFixed(4),
      /** net - gross where gross exists (≈ fees+slip+network) */
      sumNetMinusGrossUsd: +netMinusGross.toFixed(4),
    },
    whitelistTagging:
      whitelist.size > 0
        ? {
            onWhitelist: { count: wlCount, sumNetPnlUsd: +wlSumNet.toFixed(4) },
            notOnWhitelist: { count: nonWlCount, sumNetPnlUsd: +nonWlSumNet.toFixed(4) },
          }
        : { note: 'no whitelist file or empty set — skipped' },
  };
}

function overlapExitWindow(rowsBy: Record<StrategyKey, CloseRow[]>): { start: number; end: number } | null {
  const keys = (Object.keys(rowsBy) as StrategyKey[]).filter((k) => rowsBy[k].length > 0);
  if (keys.length < 2) return null;
  let start = -Infinity;
  let end = Infinity;
  for (const k of keys) {
    const xs = rowsBy[k].map((r) => r.exitTs);
    const mn = Math.min(...xs);
    const mx = Math.max(...xs);
    start = Math.max(start, mn);
    end = Math.min(end, mx);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end };
}

/** Greedy: для каждой «базовой» сделки ищем лучшее совпадение по entryTs среди неиспользованных. */
function matchSeries(
  base: CloseRow[],
  other: CloseRow[],
  windowMs: number,
): { matched: number; sumBaseNet: number; sumOtherNet: number; sumDelta: number; unmatchedBase: number } {
  const pool = [...other].sort((a, b) => a.entryTs - b.entryTs);
  const usedIdx = new Set<number>();
  let matched = 0;
  let sumBase = 0;
  let sumOth = 0;
  let sumDelta = 0;
  let unmatched = 0;
  for (const b of base.sort((a, c) => a.entryTs - c.entryTs)) {
    let best: { idx: number; di: number } | null = null;
    for (let i = 0; i < pool.length; i++) {
      if (usedIdx.has(i)) continue;
      const o = pool[i]!;
      if (o.mint !== b.mint) continue;
      const di = Math.abs(o.entryTs - b.entryTs);
      if (di > windowMs) continue;
      if (!best || di < best.di) best = { idx: i, di };
    }
    if (!best) {
      unmatched++;
      continue;
    }
    usedIdx.add(best.idx);
    const o = pool[best.idx]!;
    matched++;
    sumBase += b.netPnlUsd;
    sumOth += o.netPnlUsd;
    sumDelta += b.netPnlUsd - o.netPnlUsd;
  }
  return {
    matched,
    sumBaseNet: +sumBase.toFixed(4),
    sumOtherNet: +sumOth.toFixed(4),
    sumDelta: +sumDelta.toFixed(4),
    unmatchedBase: unmatched,
  };
}

function mintSet(rows: CloseRow[]): Set<string> {
  return new Set(rows.map((r) => r.mint));
}

function mintOverlap3(a: CloseRow[], b: CloseRow[], c: CloseRow[]) {
  const A = mintSet(a);
  const B = mintSet(b);
  const C = mintSet(c);
  const ab = [...A].filter((m) => B.has(m)).length;
  const ac = [...A].filter((m) => C.has(m)).length;
  const bc = [...B].filter((m) => C.has(m)).length;
  const abc = [...A].filter((m) => B.has(m) && C.has(m)).length;
  return {
    uniqueMints: { liveOscar: A.size, liveOscarRisky: B.size, paperOscarRisky: C.size },
    pairwiseMintIntersectionCounts: { live_liveRisky: ab, live_paper: ac, liveRisky_paper: bc, allThree: abc },
  };
}

function topMints(rows: CloseRow[], k: number): Array<{ mint: string; symbol: string; closes: number; sumNet: number }> {
  const m = new Map<string, { symbol: string; closes: number; sumNet: number }>();
  for (const r of rows) {
    const e = m.get(r.mint) ?? { symbol: r.symbol, closes: 0, sumNet: 0 };
    e.closes++;
    e.sumNet += r.netPnlUsd;
    if (!e.symbol && r.symbol) e.symbol = r.symbol;
    m.set(r.mint, e);
  }
  return [...m.entries()]
    .map(([mint, v]) => ({
      mint,
      symbol: v.symbol,
      closes: v.closes,
      sumNet: +v.sumNet.toFixed(4),
    }))
    .sort((a, b) => b.sumNet - a.sumNet)
    .slice(0, k);
}

async function main(): Promise<void> {
  const livePath = argStr('--live', '');
  const liveRiskyPath = argStr('--live-risky', '');
  const paperPath = argStr('--paper', '');
  const whitelistPath = argStr('--whitelist', '');
  const outPath = argStr('--out', '');
  const sinceMs = argNum('--since-ms', 0);
  const untilMs = argNum('--until-ms', 9e15);
  const matchWindowMs = argNum('--match-window-ms', 86_400_000);

  const whitelist = loadWhitelist(whitelistPath ? path.resolve(whitelistPath) : '');

  const raw: Record<StrategyKey, CloseRow[]> = {
    liveOscar: await loadClosesFromJournal(livePath, 'liveOscar', 'live_nested_close'),
    liveOscarRisky: await loadClosesFromJournal(liveRiskyPath, 'liveOscarRisky', 'live_nested_close'),
    paperOscarRisky: await loadClosesFromJournal(paperPath, 'paperOscarRisky', 'paper_flat_close'),
  };

  const filtered: Record<StrategyKey, CloseRow[]> = {
    liveOscar: filterByExitWindow(raw.liveOscar, sinceMs, untilMs),
    liveOscarRisky: filterByExitWindow(raw.liveOscarRisky, sinceMs, untilMs),
    paperOscarRisky: filterByExitWindow(raw.paperOscarRisky, sinceMs, untilMs),
  };

  const economic: Record<StrategyKey, CloseRow[]> = {
    liveOscar: filtered.liveOscar.filter(isEconomicCloseRow),
    liveOscarRisky: filtered.liveOscarRisky.filter(isEconomicCloseRow),
    paperOscarRisky: filtered.paperOscarRisky.filter(isEconomicCloseRow),
  };

  const win = overlapExitWindow(economic);
  const inOverlap = win
    ? {
        exitTsStart: win.start,
        exitTsEnd: win.end,
        liveOscar: filterByExitWindow(economic.liveOscar, win.start, win.end),
        liveOscarRisky: filterByExitWindow(economic.liveOscarRisky, win.start, win.end),
        paperOscarRisky: filterByExitWindow(economic.paperOscarRisky, win.start, win.end),
      }
    : null;

  const avgInvested = (rows: CloseRow[]) =>
    rows.length ? +(rows.reduce((s, r) => s + r.totalInvestedUsd, 0) / rows.length).toFixed(2) : null;

  const summary = {
    params: {
      livePath: livePath || null,
      liveRiskyPath: liveRiskyPath || null,
      paperPath: paperPath || null,
      whitelistPath: whitelistPath || null,
      whitelistSize: whitelist.size,
      sinceMs,
      untilMs,
      matchWindowMs,
    },
    rawCloseCounts: {
      liveOscar: raw.liveOscar.length,
      liveOscarRisky: raw.liveOscarRisky.length,
      paperOscarRisky: raw.paperOscarRisky.length,
    },
    dataQualityExclusions: {
      note:
        'Rows excluded from PnL/ROI/pairing: exitReason in NON_ECONOMIC (e.g. PERIODIC_HEAL) or absurd |netPnlUsd|/totalInvestedUsd (> ABSURD_USD)',
      nonEconomicExitReasons: [...NON_ECONOMIC_EXIT_REASONS],
      absurdUsdCap: ABSURD_USD,
      afterTimeWindowBeforeQuality: {
        liveOscar: exclusionStats(filtered.liveOscar, economic.liveOscar),
        liveOscarRisky: exclusionStats(filtered.liveOscarRisky, economic.liveOscarRisky),
        paperOscarRisky: exclusionStats(filtered.paperOscarRisky, economic.paperOscarRisky),
      },
    },
    filteredByArgWindow: {
      liveOscar: summarize(economic.liveOscar, whitelist),
      liveOscarRisky: summarize(economic.liveOscarRisky, whitelist),
      paperOscarRisky: summarize(economic.paperOscarRisky, whitelist),
    },
    avgTotalInvestedUsdPerClose: {
      liveOscar: avgInvested(economic.liveOscar),
      liveOscarRisky: avgInvested(economic.liveOscarRisky),
      paperOscarRisky: avgInvested(economic.paperOscarRisky),
    },
    mintOverlap: mintOverlap3(economic.liveOscar, economic.liveOscarRisky, economic.paperOscarRisky),
    sameExitCalendarIntersection:
      inOverlap == null
        ? { note: 'need at least two non-empty strategies to define intersection' }
        : {
            exitTsStart: inOverlap.exitTsStart,
            exitTsEnd: inOverlap.exitTsEnd,
            liveOscar: summarize(inOverlap.liveOscar, whitelist),
            liveOscarRisky: summarize(inOverlap.liveOscarRisky, whitelist),
            paperOscarRisky: summarize(inOverlap.paperOscarRisky, whitelist),
          },
    topMintsByNetPnl: {
      paperOscarRisky: topMints(economic.paperOscarRisky, 25),
      liveOscar: topMints(economic.liveOscar, 25),
      liveOscarRisky: topMints(economic.liveOscarRisky, 25),
    },
    /** paper как «база» — сколько сделок находит пару у live / risky с тем же mint и близким entryTs */
    pairedPaperVsLive: matchSeries(economic.paperOscarRisky, economic.liveOscar, matchWindowMs),
    pairedPaperVsLiveRisky: matchSeries(economic.paperOscarRisky, economic.liveOscarRisky, matchWindowMs),
    pairedLiveVsLiveRisky: matchSeries(economic.liveOscar, economic.liveOscarRisky, matchWindowMs),
  };

  const text = JSON.stringify(summary, null, 2);
  console.log(text);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf-8');
    console.error('wrote', abs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
