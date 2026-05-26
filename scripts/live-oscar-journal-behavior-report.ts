/**
 * Live Oscar — поведенческий отчёт по **закрытым** сделкам из live JSONL (без Postgres).
 *
 * Отвечает на вопросы вида:
 * - почему «плюсы копеечные» при большом нотионале (частичные TP, % от остатка);
 * - насколько **KILLSTOP** по величине съедает недавнюю серию мелких плюсов;
 * - смесь `exitReason`, профиль A/B, число ног и partial sells.
 *
 *   npx tsx scripts/live-oscar-journal-behavior-report.ts --journal data/live/pt1-oscar-live.jsonl
 *   npx tsx scripts/live-oscar-journal-behavior-report.ts --journal data/live/pt1-oscar-live.jsonl --last-wins 5
 *
 * Фильтр стратегии: только строки с `strategyId === live-oscar` (если поле есть).
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

type CloseLite = {
  ts: number;
  mint: string;
  symbol: string;
  exitReason: string;
  netPnlUsd: number;
  pnlPct: number;
  totalInvestedUsd: number;
  legs: number;
  partialSells: number;
  exitProfileMode: string | null;
  durationMin: number;
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

function median(nums: number[]): number | null {
  const a = nums.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function pctile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

function isCorrupt(net: number, pnlPct: number): boolean {
  return !Number.isFinite(net) || Math.abs(net) > 1e6 || !Number.isFinite(pnlPct) || Math.abs(pnlPct) > 5000;
}

async function loadCloses(journalPath: string): Promise<{ rows: CloseLite[]; skippedBad: number; skippedStrategy: number }> {
  const rows: CloseLite[] = [];
  let skippedBad = 0;
  let skippedStrategy = 0;
  const abs = path.resolve(journalPath);
  if (!fs.existsSync(abs)) {
    console.error('journal missing:', abs);
    process.exit(1);
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(abs, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim() || line[0] !== '{') continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.kind !== 'live_position_close') continue;
    if (typeof j.strategyId === 'string' && j.strategyId !== 'live-oscar') {
      skippedStrategy++;
      continue;
    }
    const ct = j.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct.mint !== 'string') continue;
    const net = Number(ct.netPnlUsd ?? 0);
    const pnlPct = Number(ct.pnlPct ?? 0);
    if (isCorrupt(net, pnlPct)) {
      skippedBad++;
      continue;
    }
    const legs = Array.isArray(ct.legs) ? ct.legs.length : 0;
    const partialSells = Array.isArray(ct.partialSells) ? ct.partialSells.length : 0;
    const mode = typeof ct.liveExitProfileMode === 'string' ? ct.liveExitProfileMode : null;
    rows.push({
      ts: Number(j.ts ?? ct.exitTs ?? 0),
      mint: ct.mint,
      symbol: String(ct.symbol ?? ''),
      exitReason: String(ct.exitReason ?? ''),
      netPnlUsd: net,
      pnlPct,
      totalInvestedUsd: Number(ct.totalInvestedUsd ?? 0),
      legs,
      partialSells,
      exitProfileMode: mode,
      durationMin: Number(ct.durationMin ?? 0),
    });
  }
  return { rows, skippedBad, skippedStrategy };
}

function mainSync(): void {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  void (async () => {
    const lastWinsLookback = Math.max(1, Math.floor(argNum('--last-wins', 5)));
    const { rows, skippedBad, skippedStrategy } = await loadCloses(journal);
    if (!rows.length) {
      console.error('No closes after filters.');
      process.exit(1);
    }

    rows.sort((a, b) => a.ts - b.ts);

    const byReason = new Map<string, { n: number; sumNet: number; wins: number; losses: number }>();
    for (const r of rows) {
      const k = r.exitReason || 'UNKNOWN';
      let b = byReason.get(k);
      if (!b) {
        b = { n: 0, sumNet: 0, wins: 0, losses: 0 };
        byReason.set(k, b);
      }
      b.n++;
      b.sumNet += r.netPnlUsd;
      if (r.netPnlUsd > 0) b.wins++;
      else if (r.netPnlUsd < 0) b.losses++;
    }

    const wins = rows.filter((r) => r.netPnlUsd > 0);
    const losses = rows.filter((r) => r.netPnlUsd < 0);
    const sumWin = wins.reduce((s, r) => s + r.netPnlUsd, 0);
    const sumLoss = losses.reduce((s, r) => s + r.netPnlUsd, 0);
    const winNets = wins.map((w) => w.netPnlUsd).sort((a, b) => a - b);

    const killRows = rows.filter((r) => r.exitReason === 'KILLSTOP');
    const killTail: Array<{
      mint: string;
      netPnlUsd: number;
      pnlPct: number;
      invested: number;
      priorConsecWinsSum: number;
      priorConsecWinsCount: number;
      ratioKillToPriorWinsSum: number | null;
      /** До kill: сумма net по **последним** N прибыльным закрытиям (не обязательно подряд; между ними могли быть минусы). */
      priorLastNWinsSum: number;
      priorLastNWinsCount: number;
      ratioKillToPriorLastNWinsSum: number | null;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.exitReason !== 'KILLSTOP') continue;
      let priorSum = 0;
      let priorCount = 0;
      for (let j = i - 1; j >= 0; j--) {
        const p = rows[j]!;
        if (p.netPnlUsd <= 0) break;
        priorSum += p.netPnlUsd;
        priorCount++;
      }
      let lastNWinsSum = 0;
      let lastNWinsCount = 0;
      for (let j = i - 1; j >= 0 && lastNWinsCount < lastWinsLookback; j--) {
        const p = rows[j]!;
        if (p.netPnlUsd <= 0) continue;
        lastNWinsSum += p.netPnlUsd;
        lastNWinsCount++;
      }
      const absKill = Math.abs(r.netPnlUsd);
      killTail.push({
        mint: r.mint,
        netPnlUsd: r.netPnlUsd,
        pnlPct: r.pnlPct,
        invested: r.totalInvestedUsd,
        priorConsecWinsSum: priorSum,
        priorConsecWinsCount: priorCount,
        ratioKillToPriorWinsSum: priorSum > 0 ? absKill / priorSum : null,
        priorLastNWinsSum: lastNWinsSum,
        priorLastNWinsCount: lastNWinsCount,
        ratioKillToPriorLastNWinsSum: lastNWinsSum > 0 ? absKill / lastNWinsSum : null,
      });
    }

    const partialHist = new Map<number, number>();
    for (const r of rows) {
      partialHist.set(r.partialSells, (partialHist.get(r.partialSells) ?? 0) + 1);
    }

    const byProfile = new Map<string, { n: number; sumNet: number }>();
    for (const r of rows) {
      const k = r.exitProfileMode ?? '(null)';
      const b = byProfile.get(k) ?? { n: 0, sumNet: 0 };
      b.n++;
      b.sumNet += r.netPnlUsd;
      byProfile.set(k, b);
    }

    const out = {
      journal: path.resolve(journal),
      strategyFilter: 'live-oscar when strategyId present',
      closes: rows.length,
      skippedCorrupt: skippedBad,
      skippedOtherStrategyId: skippedStrategy,
      totals: {
        sumNetPnlUsd: rows.reduce((s, r) => s + r.netPnlUsd, 0),
        sumWinUsd: sumWin,
        sumLossUsd: sumLoss,
        payoffWinLossRatio: sumLoss !== 0 ? sumWin / Math.abs(sumLoss) : null,
        nWins: wins.length,
        nLosses: losses.length,
        winRate: rows.length ? wins.length / rows.length : 0,
      },
      winDistributionUsd: {
        median: median(winNets),
        p75: pctile(winNets, 75),
        p90: pctile(winNets, 90),
        max: winNets.length ? winNets[winNets.length - 1]! : null,
      },
      winPnlPctWhenPositive: {
        median: median(wins.map((w) => w.pnlPct)),
        mean: wins.length ? wins.reduce((s, w) => s + w.pnlPct, 0) / wins.length : null,
      },
      investedWhenPositive: {
        median: median(wins.map((w) => w.totalInvestedUsd)),
      },
      byExitReason: Object.fromEntries(
        [...byReason.entries()].sort((a, b) => b[1].sumNet - a[1].sumNet).map(([reason, v]) => [
          reason,
          { ...v, avgNet: v.n ? v.sumNet / v.n : 0 },
        ]),
      ),
      partialSellsCountHistogram: Object.fromEntries([...partialHist.entries()].sort((a, b) => a[0] - b[0])),
      byLiveExitProfileMode: Object.fromEntries(byProfile),
      killstopVsPriorWins: {
        lastWinsLookback: lastWinsLookback,
        nKill: killRows.length,
        /** Подряд идущие плюсы сразу перед kill (обрыв на первом не-плюсе). */
        perKill: killTail,
        summary: {
          medianPriorConsecWinsSum: median(killTail.map((k) => k.priorConsecWinsSum)),
          medianRatioKillToPriorConsecWinsSum: median(
            killTail.map((k) => k.ratioKillToPriorWinsSum).filter((x): x is number => x != null),
          ),
          killsWherePriorConsecWinsSumLtAbsKill: killTail.filter(
            (k) => k.priorConsecWinsSum < Math.abs(k.netPnlUsd),
          ).length,
          medianPriorLastNWinsSum: median(killTail.map((k) => k.priorLastNWinsSum)),
          medianRatioKillToPriorLastNWinsSum: median(
            killTail.map((k) => k.ratioKillToPriorLastNWinsSum).filter((x): x is number => x != null),
          ),
          killsWherePriorLastNWinsSumLtAbsKill: killTail.filter(
            (k) => k.priorLastNWinsSum < Math.abs(k.netPnlUsd),
          ).length,
        },
      },
      note:
        'Мелкие плюсы часто следуют из сетки TP (малая доля остатка за ступень) и ранних выходов; KILLSTOP — процент от полного invested на полной позиции — может быть крупнее суммы нескольких недавних мелких TP.',
    };

    console.log(JSON.stringify(out, null, 2));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

mainSync();
