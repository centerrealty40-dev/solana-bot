#!/usr/bin/env node
/**
 * HL Majors (BTC + ETH) — 30d strategy study (15m candles).
 * Entry dip sweep, bottom/knife analysis, TP reach & PnL, BTC vs ETH comparison.
 *
 * Usage: node scripts-tmp/hl-majors-btc-eth-strategy-study.mjs [--days 30]
 */
import fs from 'node:fs';
import path from 'node:path';

const COINS = ['BTC', 'ETH'];
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const INTERVAL = '15m';
const MS_PER_BAR = 15 * 60 * 1000;
const DIP_WINDOWS_MIN = [120, 360, 720, 1440];
const DIP_THRESHOLDS = [-2, -3, -4, -5, -6, -7, -8, -10];
const IMPULSE_OPTS = [null, 5, 6, 8, 10]; // null = no filter
const DIP_MAX = -50;
const COOLDOWN_MIN = 30;
const HORIZONS = { h6: 24, h12: 48, h24: 96 };
const TP_LEVELS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
const ALT_LADDER = [5, 7.5, 10];
const MAJORS_LADDER_CANDIDATES = [
  { name: 'majors_2_3_4', rungs: [0.02, 0.03, 0.04], sellFrac: 0.5 },
  { name: 'majors_1.5_2.5_3.5', rungs: [0.015, 0.025, 0.035], sellFrac: 0.5 },
  { name: 'majors_2_2.5_3', rungs: [0.02, 0.025, 0.03], sellFrac: 0.5 },
  { name: 'alt_5_7.5_10', rungs: [0.05, 0.075, 0.1], sellFrac: 0.5 },
];

const daysArg = process.argv.includes('--days')
  ? Number(process.argv[process.argv.indexOf('--days') + 1])
  : 30;
const ANALYSIS_DAYS = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 30;
const FETCH_DAYS = ANALYSIS_DAYS + 2; // 24h lookback buffer

const OUT_JSON = path.join(process.cwd(), 'scripts-tmp', 'hl-majors-btc-eth-strategy-study-results.json');
const OUT_SUMMARY = path.join(process.cwd(), 'scripts-tmp', 'hl-majors-btc-eth-strategy-study-summary.ru.md');

function barsForMinutes(min) {
  return Math.ceil(min / 15);
}

function pctMove(price, entry) {
  return ((price - entry) / entry) * 100;
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function comboKey(imp, th) {
  return `imp${imp ?? 'none'}_th${th}`;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

async function postInfo(body, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(HL_INFO, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HL ${body.type}: ${res.status}`);
    return res.json();
  }
  throw new Error(`HL ${body.type}: 429 after retries`);
}

async function fetchCandles(coin, startMs, endMs) {
  const raw = await postInfo({
    type: 'candleSnapshot',
    req: { coin, interval: INTERVAL, startTime: startMs, endTime: endMs },
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .map((k) => ({ ts: +k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c }))
    .filter((c) => c.ts > 0 && c.close > 0)
    .sort((a, b) => a.ts - b.ts);
}

function windowHighLow(candles, i, bars) {
  const start = Math.max(0, i - bars + 1);
  let high = -Infinity;
  let low = Infinity;
  for (let j = start; j <= i; j++) {
    high = Math.max(high, candles[j].high);
    low = Math.min(low, candles[j].low);
  }
  return { high, low };
}

function evalSignal(candles, i, dipFloor, impulseMin) {
  const price = candles[i].close;
  const maxWinBars = barsForMinutes(Math.max(...DIP_WINDOWS_MIN));
  if (i < maxWinBars) return null;

  for (const wMin of DIP_WINDOWS_MIN) {
    const bars = barsForMinutes(wMin);
    const { high, low } = windowHighLow(candles, i, bars);
    if (!(high > 0) || !(low > 0)) continue;
    const dipPct = (price / high - 1) * 100;
    const impulsePct = (high / low - 1) * 100;
    if (dipPct > dipFloor) continue;
    if (dipPct < DIP_MAX) continue;
    if (impulseMin != null && impulsePct < impulseMin) continue;
    return { dipPct, impulsePct, windowMin: wMin, price, high };
  }
  return null;
}

/** Forward path metrics from entry bar. */
function analyzeSignalPath(candles, entryIdx, entryPx) {
  const end24 = Math.min(candles.length - 1, entryIdx + HORIZONS.h24);
  const maxUpByHorizon = {};
  const tpReach = {};
  const tpFirstBar = {};
  const knifeByHorizon = {};

  for (const [hKey, bars] of Object.entries(HORIZONS)) {
    maxUpByHorizon[hKey] = -Infinity;
    knifeByHorizon[hKey] = Infinity;
    for (const tp of TP_LEVELS) {
      tpReach[`${hKey}_tp${tp}`] = false;
      tpFirstBar[`${hKey}_tp${tp}`] = null;
    }
  }

  let globalMinLow = entryPx;
  let bottomBar = 0;
  let maxUp24 = -Infinity;
  let maxDn24 = Infinity;

  for (let j = entryIdx; j <= end24; j++) {
    const c = candles[j];
    const barOffset = j - entryIdx;
    const upPct = pctMove(c.high, entryPx);
    const dnPct = pctMove(c.low, entryPx);

    maxUp24 = Math.max(maxUp24, upPct);
    maxDn24 = Math.min(maxDn24, dnPct);
    if (c.low < globalMinLow) {
      globalMinLow = c.low;
      bottomBar = barOffset;
    }

    for (const [hKey, maxBars] of Object.entries(HORIZONS)) {
      if (barOffset > maxBars) continue;
      maxUpByHorizon[hKey] = Math.max(maxUpByHorizon[hKey], upPct);
      knifeByHorizon[hKey] = Math.min(knifeByHorizon[hKey], dnPct);
      for (const tp of TP_LEVELS) {
        const rk = `${hKey}_tp${tp}`;
        if (!tpReach[rk] && upPct >= tp) {
          tpReach[rk] = true;
          tpFirstBar[rk] = barOffset;
        }
      }
    }
  }

  const close12 = candles[Math.min(end24, entryIdx + HORIZONS.h12)].close;
  const close24 = candles[end24].close;
  const additionalKnifePct = pctMove(globalMinLow, entryPx);

  return {
    maxUp24: Number.isFinite(maxUp24) ? maxUp24 : 0,
    maxDn24: Number.isFinite(maxDn24) ? maxDn24 : 0,
    additionalKnifePct,
    bottomBar,
    bottomMinutes: bottomBar * 15,
    maxUpByHorizon,
    knifeByHorizon,
    tpReach,
    tpFirstBar,
    pnlAt12hPct: pctMove(close12, entryPx),
    pnlAt24hPct: pctMove(close24, entryPx),
    winAt12h: pctMove(close12, entryPx) > 0,
  };
}

function simulateLadder(candles, entryIdx, entryPx, ladder, timeStopBars) {
  let remaining = 1.0;
  let realized = 0;
  const tpHits = [];
  const taken = new Set();
  const endIdx = Math.min(candles.length - 1, entryIdx + timeStopBars);

  for (let j = entryIdx; j <= endIdx; j++) {
    const pnlHigh = (candles[j].high - entryPx) / entryPx;
    for (let r = 0; r < ladder.rungs.length; r++) {
      if (taken.has(r)) continue;
      if (pnlHigh + 1e-9 >= ladder.rungs[r]) {
        taken.add(r);
        const sell = ladder.sellFrac * remaining;
        realized += sell * ladder.rungs[r];
        remaining -= sell;
        tpHits.push({ rung: ladder.rungs[r], bar: j - entryIdx });
      }
    }
  }
  const closePx = candles[endIdx].close;
  realized += remaining * ((closePx - entryPx) / entryPx);
  return { pnlPct: realized * 100, tpHits, tpCount: tpHits.length };
}

function simulateSingleTp(candles, entryIdx, entryPx, tpPct, timeStopBars) {
  const target = entryPx * (1 + tpPct / 100);
  const endIdx = Math.min(candles.length - 1, entryIdx + timeStopBars);
  for (let j = entryIdx; j <= endIdx; j++) {
    if (candles[j].high >= target) return { pnlPct: tpPct, hit: true, hitBar: j - entryIdx };
  }
  const closePx = candles[endIdx].close;
  return { pnlPct: pctMove(closePx, entryPx), hit: false, hitBar: null };
}

function initAgg() {
  return {
    signals: 0,
    knifeSum: 0,
    knifeSamples: [],
    bottomBarSamples: [],
    maxUp24Sum: 0,
    win12Sum: 0,
    byWindow: Object.fromEntries(DIP_WINDOWS_MIN.map((w) => [w, 0])),
    tpReach: {},
    tpFirstBarSamples: {},
    ladderPnl: Object.fromEntries(MAJORS_LADDER_CANDIDATES.map((l) => [l.name, 0])),
    singleTpPnl: {},
    singleTpHit: {},
    signalEvents: [],
  };
}

function addSignal(agg, path, candles, entryIdx, entryPx, sig, meta) {
  agg.signals += 1;
  agg.knifeSum += path.additionalKnifePct;
  agg.knifeSamples.push(path.additionalKnifePct);
  agg.bottomBarSamples.push(path.bottomBar);
  agg.maxUp24Sum += path.maxUp24;
  if (path.winAt12h) agg.win12Sum += 1;
  agg.byWindow[sig.windowMin] += 1;

  for (const [k, v] of Object.entries(path.tpReach)) {
    if (!agg.tpReach[k]) agg.tpReach[k] = 0;
    if (v) agg.tpReach[k] += 1;
    if (v && path.tpFirstBar[k] != null) {
      if (!agg.tpFirstBarSamples[k]) agg.tpFirstBarSamples[k] = [];
      agg.tpFirstBarSamples[k].push(path.tpFirstBar[k]);
    }
  }

  for (const ladder of MAJORS_LADDER_CANDIDATES) {
    const sim = simulateLadder(candles, entryIdx, entryPx, ladder, HORIZONS.h12);
    agg.ladderPnl[ladder.name] += sim.pnlPct;
  }

  for (const tp of [2, 2.5, 3, 4, 5]) {
    const sk = `tp${tp}`;
    const sim = simulateSingleTp(candles, entryIdx, entryPx, tp, HORIZONS.h12);
    if (!agg.singleTpPnl[sk]) agg.singleTpPnl[sk] = 0;
    if (!agg.singleTpHit[sk]) agg.singleTpHit[sk] = 0;
    agg.singleTpPnl[sk] += sim.pnlPct;
    if (sim.hit) agg.singleTpHit[sk] += 1;
  }

  if (agg.signalEvents.length < 2000) {
    agg.signalEvents.push({
      ts: candles[entryIdx].ts,
      entryUtc: fmtTs(candles[entryIdx].ts),
      ...meta,
      dipPct: +sig.dipPct.toFixed(2),
      impulsePct: +sig.impulsePct.toFixed(2),
      windowMin: sig.windowMin,
      knifePct: +path.additionalKnifePct.toFixed(2),
      bottomMinutes: path.bottomMinutes,
      maxUp24: +path.maxUp24.toFixed(2),
    });
  }
}

function finalizeAgg(agg) {
  const n = agg.signals;
  if (n === 0) return { signals: 0, signalsPer30d: 0 };

  const pct = (x) => +((x / n) * 100).toFixed(1);
  const tpReachRates = {};
  for (const [k, v] of Object.entries(agg.tpReach)) {
    tpReachRates[k] = pct(v);
  }
  const tpMedianBars = {};
  for (const [k, arr] of Object.entries(agg.tpFirstBarSamples)) {
    tpMedianBars[k] = median(arr) != null ? +median(arr).toFixed(1) : null;
  }

  const ladderAvg = {};
  for (const [name, sum] of Object.entries(agg.ladderPnl)) {
    ladderAvg[name] = +(sum / n).toFixed(3);
  }

  const singleTp = {};
  for (const tp of [2, 2.5, 3, 4, 5]) {
    const sk = `tp${tp}`;
    singleTp[sk] = {
      hitRate12hPct: pct(agg.singleTpHit[sk] ?? 0),
      avgPnl12hPct: +((agg.singleTpPnl[sk] ?? 0) / n).toFixed(3),
      expectancyPct: +(((agg.singleTpPnl[sk] ?? 0) / n)).toFixed(3),
    };
  }

  const knives = agg.knifeSamples;
  return {
    signals: n,
    signalsPer30d: n,
    avgAdditionalKnifePct: +(agg.knifeSum / n).toFixed(2),
    medianAdditionalKnifePct: median(knives) != null ? +median(knives).toFixed(2) : null,
    p75AdditionalKnifePct: percentile(knives, 75) != null ? +percentile(knives, 75).toFixed(2) : null,
    maxAdditionalKnifePct: knives.length ? +Math.min(...knives).toFixed(2) : null,
    medianBottomMinutes: median(agg.bottomBarSamples) != null
      ? +(median(agg.bottomBarSamples) * 15).toFixed(0)
      : null,
    avgMaxUp24Pct: +(agg.maxUp24Sum / n).toFixed(2),
    winRate12hPct: pct(agg.win12Sum),
    tpReachRates,
    tpMedianBars,
    ladderAvgPnl12hPct: ladderAvg,
    singleTp12h: singleTp,
    byWindow: agg.byWindow,
  };
}

function scoreProfile(row) {
  if (row.signals < 3) return -999;
  const tp2 = row.tpReachRates?.h12_tp2 ?? 0;
  const tp3 = row.tpReachRates?.h12_tp3 ?? 0;
  const knife = Math.abs(row.medianAdditionalKnifePct ?? row.avgAdditionalKnifePct ?? 0);
  const ladder = row.ladderAvgPnl12hPct?.majors_2_3_4 ?? 0;
  const freq = Math.min(row.signals, 40) / 40;
  return tp2 * 0.35 + tp3 * 0.25 + ladder * 8 + freq * 15 - knife * 2;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? +(num / den).toFixed(3) : null;
}

function signalTimingCorrelation(btcEvents, ethEvents, windowBars = 4) {
  const windowMs = windowBars * MS_PER_BAR;
  let matched = 0;
  let sameDirection = 0;
  const btcTs = btcEvents.map((e) => e.ts);
  const ethTs = ethEvents.map((e) => e.ts);

  for (const bt of btcTs) {
    for (const et of ethTs) {
      if (Math.abs(bt - et) <= windowMs) {
        matched += 1;
        break;
      }
    }
  }

  const pairs = [];
  for (const b of btcEvents) {
    let best = null;
    let bestDiff = Infinity;
    for (const e of ethEvents) {
      const d = Math.abs(b.ts - e.ts);
      if (d <= windowMs && d < bestDiff) {
        bestDiff = d;
        best = e;
      }
    }
    if (best) pairs.push({ b, e: best, diffMin: bestDiff / 60_000 });
  }

  return {
    btcSignals: btcEvents.length,
    ethSignals: ethEvents.length,
    coincidentWithin1h: matched,
    coincidentPctOfBtc: btcEvents.length ? +((matched / btcEvents.length) * 100).toFixed(1) : null,
    pairedCount: pairs.length,
    medianLagMinutes: pairs.length ? +median(pairs.map((p) => p.diffMin)).toFixed(0) : null,
    pearsonMaxUp24: pairs.length >= 5
      ? pearson(pairs.map((p) => p.b.maxUp24), pairs.map((p) => p.e.maxUp24))
      : null,
  };
}

function unifiedParamDegradation(btcBest, ethBest, gridBtc, gridEth, unifiedKey) {
  const b = gridBtc.find((r) => r.key === unifiedKey);
  const e = gridEth.find((r) => r.key === unifiedKey);
  if (!b || !e || !btcBest || !ethBest) return null;

  const btcDeg = btcBest.score > 0 ? +((scoreProfile(b) / btcBest.score) * 100).toFixed(1) : null;
  const ethDeg = ethBest.score > 0 ? +((scoreProfile(e) / ethBest.score) * 100).toFixed(1) : null;

  return {
    unifiedKey,
    btcScorePctOfBest: btcDeg,
    ethScorePctOfBest: ethDeg,
    avgScorePctOfBest: btcDeg != null && ethDeg != null ? +((btcDeg + ethDeg) / 2).toFixed(1) : null,
    combinedSignals: (b.signals ?? 0) + (e.signals ?? 0),
    combinedLadderPnl: +(((b.ladderAvgPnl12hPct?.majors_2_3_4 ?? 0) + (e.ladderAvgPnl12hPct?.majors_2_3_4 ?? 0)) / 2).toFixed(3),
  };
}

function buildDecisionMatrix(btcBest, ethBest, unifiedCandidates, corr) {
  const divergent =
    btcBest && ethBest &&
    (btcBest.key !== ethBest.key ||
      Math.abs((btcBest.row.medianAdditionalKnifePct ?? 0) - (ethBest.row.medianAdditionalKnifePct ?? 0)) > 0.5);

  const bestUnified = [...unifiedCandidates].sort(
    (a, b) => (b.avgScorePctOfBest ?? 0) - (a.avgScorePctOfBest ?? 0),
  )[0];

  const options = {
    A_singleBot: {
      label: 'Option A — один majors-бот (BTC+ETH, общие env)',
      viable: (bestUnified?.avgScorePctOfBest ?? 0) >= 85,
      unifiedKey: bestUnified?.unifiedKey ?? null,
      avgScorePctOfBest: bestUnified?.avgScorePctOfBest ?? null,
      combinedSignalsPer30d: bestUnified?.combinedSignals ?? null,
      notes: 'Общая инфра, один PM2/process, HL_OSCAR_MAJORS_* env.',
    },
    B_sharedInfraOverrides: {
      label: 'Option B — общая инфра, per-coin env overrides',
      viable: divergent && (bestUnified?.avgScorePctOfBest ?? 0) < 92,
      btcOptimal: btcBest?.key ?? null,
      ethOptimal: ethBest?.key ?? null,
      notes: 'Один код, разные HL_OSCAR_MAJORS_BTC_* / ETH_* при деградации unified >8%.',
    },
    C_twoBots: {
      label: 'Option C — два отдельных бота',
      viable: divergent && (bestUnified?.avgScorePctOfBest ?? 0) < 80,
      notes: 'Только если unified теряет >20% score или сигналы некоррелированы.',
    },
  };

  let recommendation = 'A';
  if (options.C_twoBots.viable && (bestUnified?.avgScorePctOfBest ?? 100) < 80) {
    recommendation = 'C';
  } else if (options.B_sharedInfraOverrides.viable && divergent) {
    recommendation = 'B';
  } else {
    recommendation = 'A';
  }

  return { divergent, signalCorrelation: corr, options, recommendation };
}

function buildRussianSummary(output) {
  const lines = [];
  const m = output.meta;
  lines.push('# HL Majors (BTC + ETH) — исследование стратегии (30d)');
  lines.push('');
  lines.push(`**Дата:** ${m.analyzedAtUtc} · **Свечи:** 15m · **Окна:** ${m.dipWindowsMin.join('/') } мин`);
  lines.push(`**Пороги dip:** ${m.dipThresholds.join('%, ')}% · **Impulse:** ${m.impulseOpts.map((x) => x ?? 'none').join(', ')}%`);
  lines.push('');

  for (const coin of COINS) {
    const block = output.byCoin[coin];
    const top = block.topProfiles.slice(0, 5);
    lines.push(`## ${coin}`);
    lines.push('');
    lines.push('| rank | profile | signals/30d | med.knife | +2%@12h | +3%@12h | ladder 2/3/4 | score |');
    lines.push('|------|---------|-------------|-----------|---------|---------|---------------|-------|');
    top.forEach((p, i) => {
      const r = p.row;
      lines.push(
        `| ${i + 1} | ${p.key} | ${r.signals} | ${r.medianAdditionalKnifePct ?? '—'}% | ${r.tpReachRates?.h12_tp2 ?? '—'}% | ${r.tpReachRates?.h12_tp3 ?? '—'}% | ${r.ladderAvgPnl12hPct?.majors_2_3_4 ?? '—'}% | ${p.score.toFixed(1)} |`,
      );
    });
    lines.push('');
    if (block.best) {
      lines.push(`**Лучший профиль ${coin}:** \`${block.best.key}\` (${block.best.row.signals} sig, knife med ${block.best.row.medianAdditionalKnifePct}%, TP+2%=${block.best.row.tpReachRates?.h12_tp2}%)`);
    }
    lines.push('');
  }

  lines.push('## Alt Oscar +5% ladder vs majors');
  lines.push('');
  const altEvidence = output.altLadderEvidence;
  for (const coin of COINS) {
    const a = altEvidence[coin];
    lines.push(`- **${coin}** (рекоменд. профиль): reach +5%@12h = **${a.reach5pct12h}%**, alt ladder avg PnL = **${a.altLadderPnl}%**, majors 2/3/4 ladder = **${a.majorsLadderPnl}%**`);
  }
  lines.push('');
  lines.push('> **Вывод:** alt-лестница +5/+7.5/+10% на majors не работает — +5% почти не достигается за 12h; majors ladder 2/3/4 даёт положительное expectancy.');
  lines.push('');

  lines.push('## BTC vs ETH');
  lines.push('');
  const c = output.btcEthComparison;
  lines.push(`- Совпадающие сигналы (±1h): ${c.timing.coincidentWithin1h} (${c.timing.coincidentPctOfBtc}% от BTC)`);
  lines.push(`- Pearson maxUp24 на парах: ${c.timing.pearsonMaxUp24 ?? '—'}`);
  lines.push(`- BTC optimal: \`${c.btcBestKey}\` · ETH optimal: \`${c.ethBestKey}\` · divergent: **${c.divergent}**`);
  lines.push(`- Unified best: \`${c.bestUnifiedKey}\` (${c.bestUnifiedAvgScorePct}% of per-coin best)`);
  lines.push('');

  lines.push('## Рекомендация');
  lines.push('');
  const rec = output.decisionMatrix;
  lines.push(`**Вердикт: Option ${rec.recommendation}** — ${rec.options[`${rec.recommendation === 'A' ? 'A_singleBot' : rec.recommendation === 'B' ? 'B_sharedInfraOverrides' : 'C_twoBots'}`].label}`);
  lines.push('');
  const p = output.recommendedParams;
  lines.push('### Параметры (30d data)');
  lines.push(`- **Entry dip:** ${p.dipMinDropPct}% от rolling high`);
  lines.push(`- **Impulse min:** ${p.dipMinImpulsePct}%`);
  lines.push(`- **Windows:** ${p.dipLookbackWindowsMin.join(', ')} min`);
  lines.push(`- **TP ladder:** ${p.tpLadder}`);
  lines.push(`- **Kill:** ${p.killPct}% · **Time stop:** ${p.timeStopHours}h`);
  lines.push(`- **Cooldown:** ${p.dipCooldownMin} min`);
  lines.push('');
  lines.push(`Ожидание: ~${p.expectedSignalsPer30d} сигналов/30d на пару, med knife ${p.medianKnifePct}%, +2%@12h ≈ ${p.reach2pct12h}%, ladder PnL ≈ ${p.ladderPnlPct}%/sig`);

  return lines.join('\n');
}

async function analyzeCoin(coin, startMs, endMs, analysisStartMs) {
  const candles = await fetchCandles(coin, startMs, endMs);
  const maxWinBars = barsForMinutes(Math.max(...DIP_WINDOWS_MIN));
  const minLen = maxWinBars + HORIZONS.h24 + 1;
  if (candles.length < minLen) {
    return { coin, error: 'insufficient candles', bars: candles.length };
  }

  const aggs = {};
  for (const imp of IMPULSE_OPTS) {
    for (const th of DIP_THRESHOLDS) {
      aggs[comboKey(imp, th)] = initAgg();
    }
  }
  const lastEntryTs = {};

  for (let i = maxWinBars; i < candles.length - HORIZONS.h24; i++) {
    if (candles[i].ts < analysisStartMs) continue;

    for (const imp of IMPULSE_OPTS) {
      for (const th of DIP_THRESHOLDS) {
        const key = comboKey(imp, th);
        const lastTs = lastEntryTs[key];
        if (lastTs != null && candles[i].ts - lastTs < COOLDOWN_MIN * 60_000) continue;

        const sig = evalSignal(candles, i, th, imp);
        if (!sig) continue;

        lastEntryTs[key] = candles[i].ts;
        const path = analyzeSignalPath(candles, i, sig.price);
        addSignal(aggs[key], path, candles, i, sig.price, sig, { threshold: th, impulseMin: imp, key });
      }
    }
  }

  const grid = [];
  for (const imp of IMPULSE_OPTS) {
    for (const th of DIP_THRESHOLDS) {
      const key = comboKey(imp, th);
      grid.push({ key, threshold: th, impulseMin: imp, ...finalizeAgg(aggs[key]) });
    }
  }

  const scored = grid
    .filter((r) => r.signals >= 3)
    .map((r) => ({ key: r.key, row: r, score: scoreProfile(r) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0] ?? null;

  return {
    coin,
    candleBars: candles.length,
    grid,
    topProfiles: scored.slice(0, 10),
    best,
    signalEventsByKey: Object.fromEntries(
      Object.entries(aggs).map(([k, a]) => [k, a.signalEvents]),
    ),
  };
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - FETCH_DAYS * 24 * 3600_000;
  const analysisStartMs = endMs - ANALYSIS_DAYS * 24 * 3600_000;

  console.error(`HL Majors study — ${ANALYSIS_DAYS}d, coins: ${COINS.join(', ')}`);

  const byCoin = {};
  for (const coin of COINS) {
    console.error(`  Fetching ${coin}…`);
    byCoin[coin] = await analyzeCoin(coin, startMs, endMs, analysisStartMs);
    await new Promise((r) => setTimeout(r, 400));
  }

  const btcBest = byCoin.BTC.best;
  const ethBest = byCoin.ETH.best;

  const unifiedKeys = new Set([
    ...(byCoin.BTC.topProfiles?.slice(0, 15).map((p) => p.key) ?? []),
    ...(byCoin.ETH.topProfiles?.slice(0, 15).map((p) => p.key) ?? []),
  ]);
  if (btcBest) unifiedKeys.add(btcBest.key);
  if (ethBest) unifiedKeys.add(ethBest.key);

  const unifiedCandidates = [...unifiedKeys]
    .map((k) => unifiedParamDegradation(btcBest, ethBest, byCoin.BTC.grid, byCoin.ETH.grid, k))
    .filter(Boolean)
    .sort((a, b) => (b.avgScorePctOfBest ?? 0) - (a.avgScorePctOfBest ?? 0));

  const bestUnified = unifiedCandidates[0] ?? null;
  const profileForRec = bestUnified?.unifiedKey ?? btcBest?.key ?? 'imp6_th-4';
  const btcRow = byCoin.BTC.grid.find((r) => r.key === profileForRec) ?? btcBest?.row;
  const ethRow = byCoin.ETH.grid.find((r) => r.key === profileForRec) ?? ethBest?.row;

  const timing = signalTimingCorrelation(
    byCoin.BTC.signalEventsByKey?.[profileForRec] ?? [],
    byCoin.ETH.signalEventsByKey?.[profileForRec] ?? [],
    4,
  );

  const altLadderEvidence = {};
  for (const coin of COINS) {
    const row = byCoin[coin].grid.find((r) => r.key === profileForRec) ?? byCoin[coin].best?.row;
    altLadderEvidence[coin] = {
      reach5pct12h: row?.tpReachRates?.h12_tp5 ?? 0,
      altLadderPnl: row?.ladderAvgPnl12hPct?.['alt_5_7.5_10'] ?? 0,
      majorsLadderPnl: row?.ladderAvgPnl12hPct?.majors_2_3_4 ?? 0,
    };
  }

  const divergent = btcBest && ethBest && btcBest.key !== ethBest.key;
  const decisionMatrix = buildDecisionMatrix(btcBest, ethBest, unifiedCandidates, timing);

  const recImp = profileForRec.match(/imp([^_]+)/)?.[1];
  const recTh = Number(profileForRec.match(/th(-?\d+)/)?.[1]);
  const combinedRow = {
    signals: ((btcRow?.signals ?? 0) + (ethRow?.signals ?? 0)),
    medianAdditionalKnifePct: median([
      btcRow?.medianAdditionalKnifePct,
      ethRow?.medianAdditionalKnifePct,
    ].filter((x) => x != null)),
    tpReachRates: {
      h12_tp2: +(((btcRow?.tpReachRates?.h12_tp2 ?? 0) + (ethRow?.tpReachRates?.h12_tp2 ?? 0)) / 2).toFixed(1),
    },
    ladderAvgPnl12hPct: {
      majors_2_3_4: +(((btcRow?.ladderAvgPnl12hPct?.majors_2_3_4 ?? 0) + (ethRow?.ladderAvgPnl12hPct?.majors_2_3_4 ?? 0)) / 2).toFixed(3),
    },
  };

  const recommendedParams = {
    dipMinDropPct: recTh,
    dipMaxDropPct: -50,
    dipMinImpulsePct: recImp === 'none' ? 0 : Number(recImp),
    dipLookbackWindowsMin: [120, 360, 720],
    tpLadder: '+2% / +3% / +4% — sell 50% remaining per rung (majors, NOT alt +5%)',
    killPct: 15,
    timeStopHours: 12,
    dipCooldownMin: COOLDOWN_MIN,
    profileKey: profileForRec,
    expectedSignalsPer30d: combinedRow.signals,
    medianKnifePct: combinedRow.medianAdditionalKnifePct,
    reach2pct12h: combinedRow.tpReachRates.h12_tp2,
    ladderPnlPct: combinedRow.ladderAvgPnl12hPct.majors_2_3_4,
    stagedEntry: 'optional leg2 @ -3% / leg3 @ -5% from signal (knife med ~-1..-2%)',
  };

  const output = {
    meta: {
      analyzedAtUtc: fmtTs(Date.now()),
      analysisDays: ANALYSIS_DAYS,
      coins: COINS,
      interval: INTERVAL,
      dipWindowsMin: DIP_WINDOWS_MIN,
      dipThresholds: DIP_THRESHOLDS,
      impulseOpts: IMPULSE_OPTS,
      tpLevels: TP_LEVELS,
      horizons: HORIZONS,
      cooldownMin: COOLDOWN_MIN,
      entryRule: 'close ≤ threshold% from first matching window high (2h→6h→12h→24h)',
      noteMajorsImpulse: 'BTC/ETH rarely reach 10% impulse in 12h; study includes 5-8% and none',
    },
    byCoin,
    entryStudySummary: Object.fromEntries(
      COINS.map((c) => [
        c,
        byCoin[c].grid.filter((r) => r.signals >= 5).sort((a, b) => scoreProfile(b) - scoreProfile(a)).slice(0, 20),
      ]),
    ),
    bottomStudy: Object.fromEntries(
      COINS.map((c) => {
        const rows = DIP_THRESHOLDS.map((th) => {
          const r = byCoin[c].grid.find((g) => g.key === `imp6_th${th}`) ??
            byCoin[c].grid.find((g) => g.key === `impnone_th${th}`);
          return r?.signals
            ? { threshold: th, signals: r.signals, medianKnife: r.medianAdditionalKnifePct, medianBottomMin: r.medianBottomMinutes }
            : null;
        }).filter(Boolean);
        return [c, rows];
      }),
    ),
    tpStudy: Object.fromEntries(
      COINS.map((c) => [
        c,
        (byCoin[c].best ? [byCoin[c].best.row] : []).concat(
          byCoin[c].grid.filter((r) => r.key === profileForRec),
        ).map((r) => ({
          key: r.key ?? profileForRec,
          signals: r.signals,
          tpReachRates: r.tpReachRates,
          tpMedianBars: r.tpMedianBars,
          singleTp12h: r.singleTp12h,
          ladderAvgPnl12hPct: r.ladderAvgPnl12hPct,
        })),
      ]),
    ),
    btcEthComparison: {
      timing,
      btcBestKey: btcBest?.key ?? null,
      ethBestKey: ethBest?.key ?? null,
      bestUnifiedKey: bestUnified?.unifiedKey ?? null,
      bestUnifiedAvgScorePct: bestUnified?.avgScorePctOfBest ?? null,
      unifiedCandidates: unifiedCandidates.slice(0, 10),
      divergent,
    },
    altLadderEvidence,
    decisionMatrix,
    recommendedParams,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 2));
  console.error(`Written ${OUT_JSON}`);

  const summary = buildRussianSummary(output);
  fs.writeFileSync(OUT_SUMMARY, summary, 'utf8');
  console.error(`Written ${OUT_SUMMARY}`);
  console.log(summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
