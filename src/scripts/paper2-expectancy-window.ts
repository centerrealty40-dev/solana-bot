/**
 * Aggregate closed trades over a recent wall-clock window: exit reason, TP ladder hits,
 * peak vs close PnL — for diagnosing expectancy (trail giving back gains vs killstop tails).
 *
 *   npx tsx src/scripts/paper2-expectancy-window.ts --since-hours 6 --dir data/paper2
 *   npx tsx src/scripts/paper2-expectancy-window.ts --since-hours 6 --jsonl a.jsonl b.jsonl ../live/pt1-oscar-live.jsonl
 *
 * Windowing: by default rows are included when **exitTs** (economic exit time) >= cutoff.
 * Use `--wall-clock-window` to use max(exitTs, journal ts) — can pull old fills into short windows if logs were backfilled.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function collectJsonlPaths(): string[] {
  const i = process.argv.indexOf('--jsonl');
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < process.argv.length; k++) {
    const p = process.argv[k];
    if (p.startsWith('--')) break;
    out.push(p);
  }
  return out;
}

type CloseRow = {
  pathLabel: string;
  strategyId: string;
  symbol: string;
  exitTs: number;
  wallTs: number;
  netUsd: number;
  pnlPct: number;
  reason: string;
  ladderHits: number | null;
  peakPnlPct: number | null;
  trailingArmed: boolean | null;
  dcaLegs: number | null;
};

function extractClose(o: Record<string, unknown>, pathLabel: string): CloseRow | null {
  const kind = String(o.kind ?? '');
  let strategyId = String(o.strategyId ?? '?');
  let wallTs = typeof o.ts === 'number' ? o.ts : 0;
  let exitTs = wallTs;
  let netUsd = 0;
  let pnlPct = 0;
  let reason = '';
  let exitContext: Record<string, unknown> | undefined;
  let symbol = '';

  if (kind === 'close') {
    exitTs = typeof o.exitTs === 'number' ? o.exitTs : wallTs;
    netUsd = Number(o.netPnlUsd ?? 0);
    pnlPct = Number(o.pnlPct ?? 0);
    reason = String(o.exitReason ?? 'UNKNOWN');
    exitContext = o.exitContext as Record<string, unknown> | undefined;
    symbol = String(o.symbol ?? '');
  } else if (kind === 'live_position_close') {
    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct !== 'object') return null;
    exitTs = typeof ct.exitTs === 'number' ? ct.exitTs : wallTs;
    netUsd = Number(ct.netPnlUsd ?? 0);
    pnlPct = Number(ct.pnlPct ?? 0);
    reason = String(ct.exitReason ?? 'UNKNOWN');
    exitContext = ct.exitContext as Record<string, unknown> | undefined;
    symbol = String(ct.symbol ?? '');
  } else {
    return null;
  }

  let ladderHits: number | null = null;
  let peakPnlPct: number | null = null;
  let trailingArmed: boolean | null = null;
  let dcaLegs: number | null = null;
  if (exitContext && typeof exitContext === 'object') {
    const h = exitContext.tpLadderHits;
    if (typeof h === 'number' && Number.isFinite(h)) ladderHits = h;
    const pk = exitContext.peakPnlPct;
    if (typeof pk === 'number' && Number.isFinite(pk)) peakPnlPct = pk;
    const ta = exitContext.trailingArmed;
    if (typeof ta === 'boolean') trailingArmed = ta;
    const dl = exitContext.dcaLegsAdded;
    if (typeof dl === 'number' && Number.isFinite(dl)) dcaLegs = dl;
  }

  return {
    pathLabel,
    strategyId,
    symbol,
    exitTs,
    wallTs,
    netUsd,
    pnlPct,
    reason,
    ladderHits,
    peakPnlPct,
    trailingArmed,
    dcaLegs,
  };
}

function hitsBand(h: number | null): string {
  if (h == null || !Number.isFinite(h)) return 'unknown';
  if (h <= 0) return '0';
  if (h === 1) return '1';
  return '2+';
}

function rowWindowTs(row: CloseRow, wallClock: boolean): number {
  if (wallClock) return Math.max(row.exitTs, row.wallTs);
  return row.exitTs > 0 ? row.exitTs : row.wallTs;
}

async function scanFile(
  filePath: string,
  sinceTs: number,
  wallClockWindow: boolean,
): Promise<CloseRow[]> {
  const pathLabel = path.basename(filePath);
  const out: CloseRow[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const row = extractClose(o, pathLabel);
    if (!row) continue;
    const ts = rowWindowTs(row, wallClockWindow);
    if (ts < sinceTs) continue;
    out.push(row);
  }
  return out;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 6);
  if (!Number.isFinite(sinceH) || sinceH <= 0) {
    console.error(
      'Usage: tsx src/scripts/paper2-expectancy-window.ts --since-hours 6 (--dir <paper2> | --jsonl <a.jsonl> ...) [--wall-clock-window]',
    );
    process.exit(1);
  }

  const wallClockWindow = flag('--wall-clock-window');

  let paths = collectJsonlPaths();
  const dir = arg('--dir');
  if (dir && fs.existsSync(dir)) {
    const extra = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
    paths = [...paths, ...extra];
  }

  if (paths.length === 0) {
    console.error('Provide --dir with jsonl files or explicit --jsonl paths.');
    process.exit(1);
  }

  const seen = new Set<string>();
  paths = paths.filter((p) => {
    const k = path.resolve(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return fs.existsSync(p);
  });

  const sinceTs = Date.now() - sinceH * 3_600_000;
  console.log(
    `Window: last ${sinceH}h (${wallClockWindow ? 'max(exitTs,journal ts)' : 'exitTs (fallback journal ts)'} >= ${sinceTs})\n`,
  );
  console.log(`Files: ${paths.length}\n`);

  const all: CloseRow[] = [];
  for (const p of paths) {
    all.push(...(await scanFile(p, sinceTs, wallClockWindow)));
  }

  if (all.length === 0) {
    console.log('No closes in window.');
    return;
  }

  console.log(`Total closes in window: ${all.length}\n`);

  const byStrategyOnly = new Map<string, CloseRow[]>();
  for (const r of all) {
    if (!byStrategyOnly.has(r.strategyId)) byStrategyOnly.set(r.strategyId, []);
    byStrategyOnly.get(r.strategyId)!.push(r);
  }
  console.log('=== Leaderboard by strategyId (realized netPnlUsd) ===');
  const board = [...byStrategyOnly.entries()]
    .map(([strategyId, rows]) => {
      const nets = rows.map((x) => x.netUsd);
      const wins = nets.filter((x) => x > 0).length;
      return { strategyId, rows, nets, wins, sum: sum(nets), avg: mean(nets) };
    })
    .sort((a, b) => b.sum - a.sum);
  for (let i = 0; i < board.length; i++) {
    const b = board[i];
    const wr = b.rows.length ? ((100 * b.wins) / b.rows.length).toFixed(0) : '0';
    console.log(
      `  #${i + 1} ${b.strategyId}: n=${b.rows.length} winRate=${wr}% wins=${b.wins} sum=$${b.sum.toFixed(2)} avg=$${b.avg.toFixed(2)}`,
    );
  }
  console.log('');

  // Per strategyId
  const bySid = new Map<string, CloseRow[]>();
  for (const r of all) {
    const k = `${r.pathLabel}::${r.strategyId}`;
    if (!bySid.has(k)) bySid.set(k, []);
    bySid.get(k)!.push(r);
  }

  console.log('=== Per journal / strategyId ===');
  for (const [k, rows] of [...bySid.entries()].sort((a, b) => sum(b[1].map((x) => x.netUsd)) - sum(a[1].map((x) => x.netUsd)))) {
    const nets = rows.map((x) => x.netUsd);
    console.log(
      `${k}: n=${rows.length} sumNet=$${sum(nets).toFixed(2)} avgNet=$${mean(nets).toFixed(2)}`,
    );
  }
  console.log('');

  // By exit reason
  const byReason = new Map<string, CloseRow[]>();
  for (const r of all) {
    if (!byReason.has(r.reason)) byReason.set(r.reason, []);
    byReason.get(r.reason)!.push(r);
  }
  console.log('=== By exitReason ===');
  for (const [reason, rows] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const nets = rows.map((x) => x.netUsd);
    console.log(
      `${reason}: n=${rows.length} sum=$${sum(nets).toFixed(2)} avg=$${mean(nets).toFixed(2)}`,
    );
  }
  console.log('');

  // TRAIL × ladder hits band
  const trailRows = all.filter((r) => r.reason === 'TRAIL');
  console.log(`=== TRAIL only (n=${trailRows.length}) × tpLadderHits band ===`);
  const trailBands = new Map<string, CloseRow[]>();
  for (const r of trailRows) {
    const b = hitsBand(r.ladderHits);
    if (!trailBands.has(b)) trailBands.set(b, []);
    trailBands.get(b)!.push(r);
  }
  for (const [b, rows] of [...trailBands.entries()].sort()) {
    const nets = rows.map((x) => x.netUsd);
    const peaks = rows.map((x) => x.peakPnlPct).filter((x): x is number => x != null && Number.isFinite(x));
    console.log(
      `  hits ${b}: n=${rows.length} sumNet=$${sum(nets).toFixed(2)} avgNet=$${mean(nets).toFixed(2)}` +
        (peaks.length ? ` avgPeak=${mean(peaks).toFixed(1)}%` : ''),
    );
  }
  console.log('');

  // KILLSTOP
  const ks = all.filter((r) => r.reason === 'KILLSTOP');
  console.log(`=== KILLSTOP (n=${ks.length}) ===`);
  if (ks.length) {
    const nets = ks.map((x) => x.netUsd);
    const legs = ks.map((x) => x.dcaLegs).filter((x): x is number => x != null && Number.isFinite(x));
    console.log(
      `  sumNet=$${sum(nets).toFixed(2)} avgNet=$${mean(nets).toFixed(2)}` +
        (legs.length ? ` avgDcaLegs=${mean(legs).toFixed(2)}` : ''),
    );
  }
  console.log('');

  // CAPITAL_ROTATE (live)
  const cr = all.filter((r) => r.reason === 'CAPITAL_ROTATE');
  console.log(`=== CAPITAL_ROTATE (n=${cr.length}) ===`);
  if (cr.length) {
    const nets = cr.map((x) => x.netUsd);
    console.log(`  sumNet=$${sum(nets).toFixed(2)} avgNet=$${mean(nets).toFixed(2)}`);
  }
  console.log('');

  // "Giveback" proxy: TRAIL with peak known
  const trailPeak = trailRows.filter((r) => r.peakPnlPct != null && r.peakPnlPct > 5);
  if (trailPeak.length) {
    const givebackPp = trailPeak.map((r) => (r.peakPnlPct ?? 0) - r.pnlPct);
    console.log(`=== TRAIL with peak>5% (n=${trailPeak.length}) — peak−closePnl pp ===`);
    console.log(`  avg giveback ${mean(givebackPp).toFixed(1)} pp   avg net $${mean(trailPeak.map((x) => x.netUsd)).toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
