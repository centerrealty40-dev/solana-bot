/**
 * Aggregate exit reasons and PnL over a recent time window across one or more paper JSONL files.
 *
 *   npx tsx src/scripts/paper2-timeout-slice.ts --since-hours 24 --jsonl data/paper2/pt1-diprunner.jsonl data/paper2/pt1-oscar.jsonl ...
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
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

type CloseAgg = {
  strategyId: string;
  pathLabel: string;
  closes: number;
  sumNet: number;
  byReason: Record<string, { n: number; sumNet: number }>;
  timeoutSumNet: number;
  timeoutN: number;
};

async function scanFile(path: string, sinceTs: number): Promise<CloseAgg> {
  const pathLabel = path.replace(/.*[/\\]/, '');
  const agg: CloseAgg = {
    strategyId: '(unknown)',
    pathLabel,
    closes: 0,
    sumNet: 0,
    byReason: {},
    timeoutSumNet: 0,
    timeoutN: 0,
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: 'utf8' }),
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
    if (String(o.kind ?? '') !== 'close') continue;
    const ts = typeof o.ts === 'number' ? o.ts : 0;
    if (ts < sinceTs) continue;
    const sid = typeof o.strategyId === 'string' ? o.strategyId : '(unknown)';
    if (agg.strategyId === '(unknown)' && sid !== '(unknown)') agg.strategyId = sid;
    const reason = String(o.exitReason ?? 'UNKNOWN');
    const net = Number(o.netPnlUsd ?? 0);
    agg.closes += 1;
    agg.sumNet += net;
    if (!agg.byReason[reason]) agg.byReason[reason] = { n: 0, sumNet: 0 };
    agg.byReason[reason].n += 1;
    agg.byReason[reason].sumNet += net;
    if (reason === 'TIMEOUT') {
      agg.timeoutN += 1;
      agg.timeoutSumNet += net;
    }
  }

  return agg;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 24);
  if (!Number.isFinite(sinceH) || sinceH <= 0) {
    console.error('Usage: tsx src/scripts/paper2-timeout-slice.ts --since-hours 24 --jsonl <a.jsonl> [b.jsonl ...]');
    process.exit(1);
  }
  const paths = collectJsonlPaths();
  if (paths.length === 0) {
    console.error('Provide at least one --jsonl path.');
    process.exit(1);
  }

  const sinceTs = Date.now() - sinceH * 3_600_000;
  console.log(`\n=== Paper closes in last ${sinceH}h (ts >= ${sinceTs}) ===\n`);

  const rows: CloseAgg[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.warn(`skip missing file: ${p}`);
      continue;
    }
    rows.push(await scanFile(p, sinceTs));
  }

  for (const r of rows) {
    console.log(`— ${r.pathLabel} (${r.strategyId})`);
    console.log(`  closes: ${r.closes}   sum netPnlUsd: ${r.sumNet.toFixed(2)}`);
    console.log(
      `  TIMEOUT: ${r.timeoutN}   TIMEOUT sum netPnlUsd: ${r.timeoutSumNet.toFixed(2)}   TIMEOUT share: ${
        r.closes ? ((100 * r.timeoutN) / r.closes).toFixed(1) : '0'
      }%`,
    );
    const reasons = Object.entries(r.byReason).sort((a, b) => b[1].n - a[1].n);
    for (const [reason, v] of reasons) {
      console.log(`    ${reason}: n=${v.n} sum=${v.sumNet.toFixed(2)}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
