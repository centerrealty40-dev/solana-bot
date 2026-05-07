/**
 * Эмпирический подбор post-exit → next-entry cooldown для Live Oscar по **фактическим** закрытым сделкам в JSONL.
 * Не трогает прод-код; PG/графики не нужны — только временные метки и realized net из журнала.
 *
 * Логика совпадает с `paper2-counterfactual-gates.ts` (секция J):
 *   (A) пауза после **любого** закрытия на том же mint — как `lastPostExitBuyCooldownTsByMint` + gate в dip-clones;
 *   (B) loss-only: пауза только если **предыдущая принятая** сделка на mint закрылась в минус.
 *
 *   npx tsx src/scripts/live-oscar-cooldown-backtest.ts \
 *     --jsonl data/live/pt1-oscar-live.jsonl \
 *     --since-hours 8760 \
 *     --norm-first-leg-usd 100 \
 *     --slots 1 \
 *     --sweep-hours 0,0.167,0.5,1,2,12,24
 *
 * --sweep-hours: дробные часы (0.5 = 30 мин; ~0.167 ≈ 10 мин).
 *
 * Важно: при `--slots 1` и плотном журнале выигрывает **очередь капитала** (cap_skip), а не cooldown —
 * смотрите строки exK/Δ$ при K, близком к реальному числу одновременных позиций (часто 4–16 для оценки «без очереди»).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

/** Локальная копия формы из `paper2-loss-attribution-deep-dive.ts` — без импорта PG/db. */
type ClosedPair = {
  mint: string;
  symbol: string;
  entryTs: number;
  exitTs: number;
  netUsd: number;
  pnlPct: number;
  reason: string;
  openTrade: Record<string, unknown>;
  closedTrade: Record<string, unknown>;
  hadAvgDown?: boolean;
};

type PendingSlot = {
  ot: Record<string, unknown>;
  hadAvgDown: boolean;
};

/** Только файловое чтение — не требует `DATABASE_URL`. Логика совпадает с `scanJournal` в deep-dive. */
async function scanJournalLive(filePath: string, sinceCloseMs: number): Promise<ClosedPair[]> {
  const pending = new Map<string, PendingSlot>();
  const out: ClosedPair[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
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

    if (kind === 'live_position_open') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (mint && ot) pending.set(mint, { ot, hadAvgDown: false });
      continue;
    }
    if (kind === 'live_position_scale_in' || kind === 'live_position_dca') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (mint && ot) {
        const prev = pending.get(mint);
        pending.set(mint, { ot, hadAvgDown: true || (prev?.hadAvgDown ?? false) });
      }
      continue;
    }
    if (kind === 'live_position_partial_sell') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (mint && ot) {
        const prev = pending.get(mint);
        pending.set(mint, { ot, hadAvgDown: prev?.hadAvgDown ?? false });
      }
      continue;
    }
    if (kind === 'live_position_close' && mint) {
      const ct = e.closedTrade as Record<string, unknown> | undefined;
      if (!ct) continue;
      const exitTs = typeof ct.exitTs === 'number' ? ct.exitTs : Number(e.ts ?? 0);
      const wallTs = typeof e.ts === 'number' ? e.ts : exitTs;
      const windowTs = Math.max(exitTs, wallTs);
      if (windowTs < sinceCloseMs) {
        pending.delete(mint);
        continue;
      }
      const slot = pending.get(mint);
      const ot = slot?.ot ?? (ct as Record<string, unknown>);
      const hadAvgDown = slot?.hadAvgDown ?? false;
      pending.delete(mint);
      out.push({
        mint,
        symbol: String(ct.symbol ?? ''),
        entryTs: Number(ot.entryTs ?? ct.entryTs ?? 0),
        exitTs,
        netUsd: Number(ct.netPnlUsd ?? 0),
        pnlPct: Number(ct.pnlPct ?? 0),
        reason: String(ct.exitReason ?? ''),
        openTrade: ot,
        closedTrade: ct,
        hadAvgDown,
      });
      continue;
    }

    if (kind === 'close' && mint) {
      const exitTs = typeof e.exitTs === 'number' ? e.exitTs : Number(e.ts ?? 0);
      const wallTs = typeof e.ts === 'number' ? e.ts : exitTs;
      const windowTs = Math.max(exitTs, wallTs);
      if (windowTs < sinceCloseMs) continue;
      const slot = pending.get(mint);
      if (!slot) continue;
      pending.delete(mint);
      const { ot, hadAvgDown } = slot;
      out.push({
        mint,
        symbol: String(e.symbol ?? ''),
        entryTs: Number(ot.entryTs ?? e.entryTs ?? 0),
        exitTs,
        netUsd: Number(e.netPnlUsd ?? 0),
        pnlPct: Number(e.pnlPct ?? 0),
        reason: String(e.exitReason ?? ''),
        openTrade: ot,
        closedTrade: e,
        hadAvgDown,
      });
      continue;
    }

    if (kind === 'dca_add' || kind === 'scale_in_add') {
      const slot = pending.get(mint);
      if (slot) slot.hadAvgDown = true;
      continue;
    }

    if (kind === 'open' && mint) {
      pending.set(mint, { ot: e, hadAvgDown: false });
    }
  }
  return out;
}

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

type ScaleBasis = 'first_leg' | 'total_invested' | 'raw';

type SimRow = ClosedPair & {
  netUsdNorm: number;
  scaleBasis: ScaleBasis;
  basisUsd: number;
};

function scaledNetForNormLeg(netUsd: number, open: Record<string, unknown>, normFirstLegUsd: number): {
  netUsdNorm: number;
  scaleBasis: ScaleBasis;
  basisUsd: number;
} {
  const legs = open.legs as Array<{ sizeUsd?: number }> | undefined;
  const firstLeg = Number(legs?.[0]?.sizeUsd ?? 0);
  const totalInv = Number(open.totalInvestedUsd ?? 0);
  if (firstLeg > 0) {
    return {
      netUsdNorm: netUsd * (normFirstLegUsd / firstLeg),
      scaleBasis: 'first_leg',
      basisUsd: firstLeg,
    };
  }
  if (totalInv > 0) {
    return {
      netUsdNorm: netUsd * (normFirstLegUsd / totalInv),
      scaleBasis: 'total_invested',
      basisUsd: totalInv,
    };
  }
  return { netUsdNorm: netUsd, scaleBasis: 'raw', basisUsd: 0 };
}

function rowKey(r: Pick<SimRow, 'mint' | 'entryTs' | 'exitTs'>): string {
  return `${r.mint}:${r.entryTs}:${r.exitTs}`;
}

function dedupeRows(rows: SimRow[]): SimRow[] {
  const seen = new Set<string>();
  const out: SimRow[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function toKeySet(arr: SimRow[]): Set<string> {
  return new Set(arr.map(rowKey));
}

function groupByMint(rows: SimRow[]): Map<string, SimRow[]> {
  const byMint = new Map<string, SimRow[]>();
  for (const r of rows) {
    const arr = byMint.get(r.mint) ?? [];
    arr.push(r);
    byMint.set(r.mint, arr);
  }
  return byMint;
}

function sumNet(rows: SimRow[]): { n: number; sum: number; avg: number } {
  const n = rows.length;
  const sum = rows.reduce((s, r) => s + r.netUsdNorm, 0);
  return { n, sum, avg: n ? sum / n : 0 };
}

/** Минимальный gap exit → следующий entry на том же mint после любого закрытия. */
function policyExitCooldownAfterAnyClose(rows: SimRow[], hours: number): SimRow[] {
  const ms = hours * 3_600_000;
  const kept: SimRow[] = [];
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let lastExit = 0;
    for (const t of arr) {
      if (lastExit > 0 && t.entryTs < lastExit + ms) continue;
      kept.push(t);
      lastExit = t.exitTs;
    }
  }
  return kept;
}

/** Пауза только после убыточного закрытия (по предыдущей **принятой** сделке на mint). */
function policyLossOnlyExitCooldown(rows: SimRow[], hours: number): SimRow[] {
  const ms = hours * 3_600_000;
  const kept: SimRow[] = [];
  for (const [, arr] of groupByMint(rows)) {
    arr.sort((a, b) => a.entryTs - b.entryTs);
    let lastKept: SimRow | null = null;
    for (const t of arr) {
      if (!lastKept) {
        kept.push(t);
        lastKept = t;
        continue;
      }
      const needGap = lastKept.netUsdNorm < 0;
      const gapOk = t.entryTs >= lastKept.exitTs + ms;
      if (!needGap || gapOk) {
        kept.push(t);
        lastKept = t;
      }
    }
  }
  return kept;
}

function slotQueueSim(
  rows: SimRow[],
  kept: Set<string>,
  slots: number,
): {
  n: number;
  sum: number;
  blockedPolicy: number;
  blockedCapacity: number;
  maxDdUsd: number;
} {
  const kSlots = Math.max(1, Math.floor(slots));
  const sorted = [...rows].sort((a, b) => a.entryTs - b.entryTs || a.exitTs - b.exitTs);
  const freeAt = Array.from({ length: kSlots }, () => 0);
  let sum = 0;
  let n = 0;
  let blockedPolicy = 0;
  let blockedCapacity = 0;
  const execPnls: number[] = [];
  for (const r of sorted) {
    const k = rowKey(r);
    if (!kept.has(k)) {
      blockedPolicy++;
      continue;
    }
    let bestIdx = -1;
    let bestFree = -Infinity;
    for (let i = 0; i < kSlots; i++) {
      if (freeAt[i] <= r.entryTs && freeAt[i] > bestFree) {
        bestFree = freeAt[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      blockedCapacity++;
      continue;
    }
    freeAt[bestIdx] = r.exitTs;
    sum += r.netUsdNorm;
    n++;
    execPnls.push(r.netUsdNorm);
  }
  let cum = 0;
  let peak = 0;
  let maxDdUsd = 0;
  for (const p of execPnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDdUsd = Math.max(maxDdUsd, peak - cum);
  }
  return { n, sum, blockedPolicy, blockedCapacity, maxDdUsd };
}

function parseSweepHours(raw: string): number[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0),
    ),
  ].sort((a, b) => a - b);
}

function fmtH(h: number): string {
  if (h === 0) return '0';
  const m = Math.round(h * 60);
  if (m < 60) return `${m}m`;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(3)}h`;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 8760);
  const normFirstLegUsdRaw = Number(arg('--norm-first-leg-usd') ?? 100);
  const normFirstLegUsd =
    Number.isFinite(normFirstLegUsdRaw) && normFirstLegUsdRaw > 0 ? normFirstLegUsdRaw : 100;
  const slotsK = Math.max(1, Math.floor(Number(arg('--slots') ?? 1)));
  const sweepRaw =
    arg('--sweep-hours') ?? '0,0.16666666666666666,0.5,1,2,12,24';

  let paths = collectJsonlPaths();
  const dir = arg('--dir');
  if (dir && fs.existsSync(dir)) {
    paths.push(
      ...fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f)),
    );
  }
  paths = [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
  if (paths.length === 0) {
    console.error('Usage: provide --jsonl <file.jsonl>[,more...] or --dir');
    process.exit(1);
  }

  const sinceCloseMs = Date.now() - sinceH * 3_600_000;
  const pairs: ClosedPair[] = [];
  for (const p of paths) {
    pairs.push(...(await scanJournalLive(p, sinceCloseMs)));
  }

  const rowsRaw: SimRow[] = pairs.map((p) => {
    const sc = scaledNetForNormLeg(p.netUsd, p.openTrade, normFirstLegUsd);
    return { ...p, netUsdNorm: sc.netUsdNorm, scaleBasis: sc.scaleBasis, basisUsd: sc.basisUsd };
  });
  const rows = dedupeRows(rowsRaw);
  const dup = rowsRaw.length - rows.length;
  const sweepHours = parseSweepHours(sweepRaw);

  const baselineKeys = toKeySet(rows);
  const baselineSim = slotQueueSim(rows, baselineKeys, slotsK);
  const baseSum = sumNet(rows);

  console.log('\n=== Live Oscar — эмпирический cooldown (только журнал, без PG) ===\n');
  console.log(`Файлы: ${paths.join(', ')}`);
  console.log(`Окно: последние ${sinceH} ч по времени закрытия`);
  console.log(`Закрытых round-trip (после дедупа): ${rows.length}${dup ? ` (dedup ${dup})` : ''}`);
  console.log(`Масштаб PnL: как если бы первая нога = $${normFirstLegUsd} (от legs[0].sizeUsd / totalInvestedUsd)`);
  console.log(`Параллельных слотов (greedy по entry/exit): ${slotsK}`);
  console.log(`Baseline subset: n=${baseSum.n} sum=$${baseSum.sum.toFixed(2)} avg=$${baseSum.avg.toFixed(2)}`);
  console.log(
    `Baseline exec@${slotsK}: n=${baselineSim.n} sum=$${baselineSim.sum.toFixed(2)} maxDD=$${baselineSim.maxDdUsd.toFixed(2)} policy_skip=${baselineSim.blockedPolicy} cap_skip=${baselineSim.blockedCapacity}`,
  );

  console.log(
    '\nИнтерпретация: строки ниже — какие **фактические** повторные входы на тот же mint были бы **запрещены**, если минимальный зазор exit→entry = H.\n',
  );

  function printBlock(title: string, policy: (r: SimRow[], h: number) => SimRow[]): void {
    console.log(`\n--- ${title} ---`);
    console.log(
      `${'H'.padEnd(10)} ${'label'.padEnd(8)} ${'kept_n'.padStart(7)} ${'subset$'.padStart(10)} ${'avg'.padStart(8)} ${`ex${slotsK}`.padStart(5)} ${`@${slotsK}$`.padStart(10)} ${'Δ$'.padStart(10)} ${'maxDD'.padStart(8)}`,
    );
    let bestDelta = -Infinity;
    let bestH = -1;
    let bestSum = 0;
    for (const h of sweepHours) {
      const kept = policy(rows, h);
      const sn = sumNet(kept);
      const sim = slotQueueSim(rows, toKeySet(kept), slotsK);
      const d = sim.sum - baselineSim.sum;
      if (d > bestDelta) {
        bestDelta = d;
        bestH = h;
        bestSum = sim.sum;
      }
      console.log(
        `${String(h).padEnd(10)} ${fmtH(h).padEnd(8)} ${String(sn.n).padStart(7)} ${sn.sum.toFixed(2).padStart(10)} ${sn.avg.toFixed(2).padStart(8)} ${String(sim.n).padStart(5)} ${sim.sum.toFixed(2).padStart(10)} ${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(9)} ${sim.maxDdUsd.toFixed(2).padStart(8)}`,
      );
    }
    console.log(
      `\n>>> Максимум exec@${slotsK} (${title.slice(0, 50)}…): H=${fmtH(bestH)} (${bestH} ч) → sum=$${bestSum.toFixed(2)} (Δ ${bestDelta >= 0 ? '+' : ''}${bestDelta.toFixed(2)} к baseline exec).`,
    );
  }

  printBlock('(A) После ЛЮБОГО закрытия — минимум H до следующего entry (как текущий post-exit map)', policyExitCooldownAfterAnyClose);
  printBlock('(B) Loss-only — пауза H только после убыточного закрытия', policyLossOnlyExitCooldown);

  console.log(
    `\n--- Примечание ---\n` +
      `Оптимум зависит от окна и журнала; для решения смотрите строку Δ$ при вашем реальном K слотов.\n` +
      `Если оптимум на H=0 и отрицательный Δ при H>0 — более длинный cooldown на этом сэмпле «отрезает» перевьючивающие повторные входы.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
