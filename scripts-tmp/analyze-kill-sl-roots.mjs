/**
 * Корневая диагностика: KILLSTOP / SL по JSONL (фичи из open рядом по mint+entryTs).
 *   node scripts-tmp/analyze-kill-sl-roots.mjs
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['pt1-dno.jsonl', 'pt1-diprunner.jsonl', 'pt1-oscar.jsonl'].map((f) =>
  path.join(root, 'data/paper2', f),
);

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function quantiles(xs) {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, min: s[0], p50: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

async function scan(pathFile) {
  const opens = new Map(); // key mint:entryTs -> features
  const closes = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(pathFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    const kind = e.kind;
    const sid = e.strategyId ?? '';
    if (kind === 'open') {
      const k = `${e.mint}:${e.entryTs}`;
      opens.set(k, {
        strategyId: sid,
        symbol: e.symbol,
        features: e.features && typeof e.features === 'object' ? e.features : {},
      });
    }
    if (kind === 'close') {
      closes.push({
        strategyId: sid,
        mint: e.mint,
        symbol: e.symbol,
        entryTs: e.entryTs,
        exitReason: e.exitReason,
        netUsd: Number(e.netPnlUsd ?? 0),
        pnlPct: Number(e.pnlPct ?? 0),
        invested: Number(e.totalInvestedUsd ?? 0),
        dcaLegs: Array.isArray(e.legs) ? e.legs.filter((l) => l.reason === 'dca').length : 0,
      });
    }
  }
  return { opens, closes, label: path.basename(pathFile) };
}

function featNum(f, ...keys) {
  for (const k of keys) {
    if (f[k] != null && Number.isFinite(Number(f[k]))) return Number(f[k]);
  }
  return null;
}

function enrich(opens, c) {
  const o = opens.get(`${c.mint}:${c.entryTs}`);
  const f = o?.features ?? {};
  return {
    ...c,
    dipPct: featNum(f, 'dip_pct'),
    impulsePct: featNum(f, 'impulse_pct'),
    liqUsd: featNum(f, 'liq_usd'),
    vol5mUsd: featNum(f, 'vol5m_usd'),
    holders: featNum(f, 'holders', 'holder_count', 'holders_now'),
    buySell: featNum(f, 'buy_sell_ratio_5m'),
  };
}

function bucketCompare(label, killers, baseline) {
  console.log(`\n--- ${label} vs baseline closes (entry features) ---`);
  const keys = ['dipPct', 'impulsePct', 'liqUsd', 'vol5mUsd', 'holders'];
  for (const k of keys) {
    const a = killers.map((r) => r[k]).filter((x) => x != null && Number.isFinite(x));
    const b = baseline.map((r) => r[k]).filter((x) => x != null && Number.isFinite(x));
    const qa = quantiles(a);
    const qb = quantiles(b);
    if (!qa || !qb) {
      console.log(`  ${k}: insufficient data`);
      continue;
    }
    console.log(
      `  ${k}: killers n=${qa.n} p50=${qa.p50?.toFixed(2)} | baseline n=${qb.n} p50=${qb.p50?.toFixed(2)}`,
    );
  }
}

async function main() {
  console.log('=== KILLSTOP / SL root scan (journal features) ===\n');

  const allKill = [];
  const allSl = [];
  const allOther = [];

  for (const fp of FILES) {
    if (!fs.existsSync(fp)) {
      console.warn('skip missing', fp);
      continue;
    }
    const { opens, closes, label } = await scan(fp);
    const enriched = closes.map((c) => enrich(opens, c));
    for (const r of enriched) {
      const row = { ...r, journal: label };
      if (r.exitReason === 'KILLSTOP') allKill.push(row);
      else if (r.exitReason === 'SL') allSl.push(row);
      else allOther.push(row);
    }
  }

  console.log(`KILLSTOP total: ${allKill.length}   SL total: ${allSl.length}   other closes: ${allOther.length}`);
  const killSum = allKill.reduce((s, r) => s + r.netUsd, 0);
  const slSum = allSl.reduce((s, r) => s + r.netUsd, 0);
  console.log(`KILLSTOP sum net: $${killSum.toFixed(2)}   SL sum net: $${slSum.toFixed(2)}`);

  const bySid = new Map();
  for (const r of allKill) {
    if (!bySid.has(r.strategyId)) bySid.set(r.strategyId, []);
    bySid.get(r.strategyId).push(r);
  }
  console.log('\nKILLSTOP by strategyId:');
  for (const [sid, rs] of [...bySid.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = rs.reduce((u, x) => u + x.netUsd, 0);
    console.log(
      `  ${sid}: n=${rs.length} sum=$${s.toFixed(2)} avgInvested=$${mean(rs.map((x) => x.invested)).toFixed(0)} avgDcaLegs=${mean(rs.map((x) => x.dcaLegs)).toFixed(1)}`,
    );
  }

  console.log('\nKILLSTOP rows (all):');
  for (const r of [...allKill].sort((a, b) => a.netUsd - b.netUsd)) {
    console.log(
      `  $${r.netUsd.toFixed(2)} (${r.pnlPct.toFixed(1)}%) ${r.strategyId} ${r.symbol} inv$${r.invested} dca${r.dcaLegs} dip%=${r.dipPct?.toFixed(1) ?? '?'} imp%=${r.impulsePct?.toFixed(1) ?? '?'} liq=${r.liqUsd?.toFixed(0) ?? '?'}`,
    );
  }

  console.log('\nSL rows (все стратегии — проверка источника):');
  const slBy = new Map();
  for (const r of allSl) {
    slBy.set(r.strategyId, (slBy.get(r.strategyId) ?? 0) + 1);
  }
  console.log('  counts by strategy:', Object.fromEntries(slBy));
  for (const r of allSl.slice(0, 20)) {
    const xa = r.invested > 0 ? (1 + r.pnlPct / 100) : null;
    console.log(
      `  $${r.netUsd.toFixed(2)} (${r.pnlPct.toFixed(1)}%) ${r.strategyId} ${r.symbol} xAvg~${xa?.toFixed(3) ?? '?'} dip%=${r.dipPct?.toFixed(1) ?? '?'}`,
    );
  }

  bucketCompare(
    'KILLSTOP',
    allKill,
    allOther.filter((r) => r.netUsd > 0),
  );
  bucketCompare(
    'KILLSTOP',
    allKill,
    allOther,
  );

  console.log('\n=== Вывод по механике (код tracker) ===');
  console.log(
    '  KILLSTOP: срабатывает при (price/avgEntry - 1) <= PAPER_DCA_KILLSTOP (доля), до TP/TRAIL/TIMEOUT.',
  );
  console.log(
    '  SL: только если PAPER_SL_X > 0 и xAvg <= slX. В ecosystem для pt1-* сейчас PAPER_SL_X=0 → SL в журнале означает либо другой runtime-env на VPS, либо наследие старого конфига.',
  );
  console.log(
    '  Итог: «kill убивает профит» = мало сделок с большим notional после DCA × глубокий процент = тяжёлый хвост; это не обязательно «плохие монеты», а сочетание пути цены и размера позиции у стопа.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
