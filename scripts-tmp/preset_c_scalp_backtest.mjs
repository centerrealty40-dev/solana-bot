/**
 * Preset C scalp policy variants — counterfactual on closed-trade cohort.
 * Uses full journal-derived trades from preset-c-2week-analysis (not journal-only subset).
 *
 * Run locally:
 *   node scripts-tmp/preset-c-2week-analysis.mjs   # refresh cohort (VPS or local journal)
 *   node scripts-tmp/preset_c_scalp_backtest.mjs
 *
 * Env:
 *   ANALYSIS_JSON — path to preset_c_2week_analysis.json
 *   OUT — report path (default scripts-tmp/preset_c_scalp_backtest_report.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ?? path.join(__dirname, '..');
const ANALYSIS_JSON =
  process.env.ANALYSIS_JSON ?? path.join(ROOT, 'scripts-tmp/preset_c_2week_analysis.json');
const OUT = process.env.OUT ?? path.join(ROOT, 'scripts-tmp/preset_c_scalp_backtest_report.json');

function num(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function summarize(trades) {
  const n = trades.length;
  const totalPnlUsd = trades.reduce((a, t) => a + num(t.netPnlUsd), 0);
  const wins = trades.filter((t) => num(t.netPnlUsd) > 0).length;
  const invested = trades.reduce((a, t) => a + num(t.investedUsd), 0);
  const kills = trades.filter((t) => t.exitReason === 'KILLSTOP');
  const killPnl = kills.reduce((a, t) => a + num(t.netPnlUsd), 0);
  const tp = trades.filter((t) => t.exitReason === 'TP');
  const tpPnl = tp.reduce((a, t) => a + num(t.netPnlUsd), 0);
  return {
    n,
    totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    investedUsd: Math.round(invested),
    killN: kills.length,
    killPnlUsd: Math.round(killPnl * 100) / 100,
    tpN: tp.length,
    tpPnlUsd: Math.round(tpPnl * 100) / 100,
  };
}

function scalpCohort(all) {
  return all.filter(
    (t) =>
      t.era?.exitPolicyScalp === true ||
      t.exitPolicy === 'preset_c_scalp_v1' ||
      (t.investedUsd <= 55 && t.era?.postScalp),
  );
}

const VARIANTS = {
  baseline: {
    label: 'baseline ($50, −10% entry, TP +5/+10/+15% vs anchor, kill −50%)',
    filter: () => true,
  },
  fill_guard_13: {
    label: 'skip entries with fill >13% below anchor',
    filter: (t) => t.entryDropPct == null || t.entryDropPct <= 13 + 1e-6,
  },
  mcap_5m: {
    label: 'min mcap $5M when known',
    filter: (t) => !(t.mcapUsd > 0) || t.mcapUsd >= 5_000_000,
  },
  mcap_5m_spike: {
    label: 'spike path only: min mcap $5M',
    filter: (t) => t.entryPath !== 'preset_c_spike' || !(t.mcapUsd > 0) || t.mcapUsd >= 5_000_000,
  },
  fill_guard_13_mcap_5m_spike: {
    label: 'fill_guard_13 + spike mcap $5M (recommended combo)',
    filter: (t) =>
      (t.entryDropPct == null || t.entryDropPct <= 13 + 1e-6) &&
      (t.entryPath !== 'preset_c_spike' || !(t.mcapUsd > 0) || t.mcapUsd >= 5_000_000),
  },
  kill_tighter: {
    label: 'hypothetical: cap loss at −30% vs anchor (exclude deeper kill PnL)',
    filter: () => true,
    adjustPnl: (t) => {
      if (t.exitReason !== 'KILLSTOP') return t.netPnlUsd;
      const invested = num(t.investedUsd);
      if (!(invested > 0)) return t.netPnlUsd;
      const capped = -invested * 0.3;
      return Math.max(num(t.netPnlUsd), capped);
    },
  },
  dca_light: {
    label: 'hypothetical: +$50 DCA @ −20% (2× notional on deep losers — rough)',
    filter: () => true,
    adjustPnl: (t) => {
      if (t.exitReason !== 'KILLSTOP' || num(t.entryDropPct) < 15) return t.netPnlUsd;
      const invested = num(t.investedUsd);
      return num(t.netPnlUsd) * 1.15;
    },
  },
  tp_2step: {
    label: 'hypothetical: simpler TP +8/+15 (approx from partial count)',
    filter: () => true,
    adjustPnl: (t) => {
      if (t.exitReason !== 'TP') return t.netPnlUsd;
      return num(t.netPnlUsd) * 0.95;
    },
  },
  tp_vs_entry: {
    label: 'hypothetical: TP +5/+10 vs avg entry instead of anchor',
    filter: () => true,
    adjustPnl: (t) => {
      const peakVsEntry = num(t.peakPnlPct);
      if (t.hadPartialTp && peakVsEntry < 12) {
        return num(t.netPnlUsd) * 0.9;
      }
      if (t.exitReason === 'TP' && peakVsEntry < 8) {
        return num(t.netPnlUsd) * 0.85;
      }
      if (t.reachedPlus5 && !t.hadPartialTp && peakVsEntry >= 5 && peakVsEntry < 10) {
        return num(t.netPnlUsd) * 1.05;
      }
      return t.netPnlUsd;
    },
  },
};

function main() {
  const raw = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf8'));
  const allClosed = raw.closedTrades ?? [];
  const cohort = scalpCohort(allClosed);
  const baseline = summarize(cohort);

  const rows = [];
  for (const [key, spec] of Object.entries(VARIANTS)) {
    const kept = cohort.filter(spec.filter);
    const adjusted = kept.map((t) => ({
      ...t,
      netPnlUsd: spec.adjustPnl ? spec.adjustPnl(t) : t.netPnlUsd,
    }));
    const stats = summarize(adjusted);
    rows.push({
      variant: key,
      label: spec.label,
      keptN: stats.n,
      skippedN: cohort.length - kept.length,
      ...stats,
      deltaPnlUsd: Math.round((stats.totalPnlUsd - baseline.totalPnlUsd) * 100) / 100,
    });
  }

  rows.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  const report = {
    generatedAt: new Date().toISOString(),
    analysisJson: ANALYSIS_JSON,
    cohort: {
      scalpTrades: cohort.length,
      allClosed: allClosed.length,
      baseline,
    },
    variants: rows,
    recommendation: rows[0]?.variant ?? 'baseline',
    deployed: ['fill_guard_13', 'mcap_5m_spike'],
    rejected: ['dca_light', 'tp_2step', 'tp_vs_entry', 'kill_tighter'],
  };

  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('Preset C scalp backtest (closed-trade counterfactual)');
  console.log(`Cohort: ${cohort.length} scalp-era trades (${allClosed.length} total closed)`);
  console.log('');
  console.log('variant\tkept\ttotalPnL\twin%\tkillN\tdeltaVsBaseline');
  for (const r of rows) {
    console.log(
      `${r.variant}\t${r.keptN}\t${r.totalPnlUsd >= 0 ? '+' : ''}${r.totalPnlUsd}\t${r.winRatePct}%\t${r.killN}\t${r.deltaPnlUsd >= 0 ? '+' : ''}${r.deltaPnlUsd}`,
    );
  }
  console.log(`\nWrote ${OUT}`);
}

main();
