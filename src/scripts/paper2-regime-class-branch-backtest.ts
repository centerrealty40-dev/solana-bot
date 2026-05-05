/**
 * Compare TP policies **by tp-regime class at entry** (PG path ending at entry):
 *
 * - **entryReg** — как сейчас: `stampTpRegimeAtHistoricalEntry` (down→агрессив, sideways→max 2 rungs).
 * - **symbiosis** — предложение пользователя: **sideways** ветвится по факту усреднения в журнале:
 *   `hadAvgDown` → профиль как у **down** (скальп/1 rung); иначе **flat** (полная лестница env).
 *   **down** всегда агрессивный профиль (один режим). **up/unknown** — без overrides.
 * - **dualDown** — контрфакт только для класса **down**: агрессив только если было усреднение;
 *   без усреднения — flat. Остальные классы как **entryReg**.
 *
 * Флаг `hadAvgDown` на закрытии: paper `dca_add` / `scale_in_add`; live `live_position_dca` / `live_position_scale_in`.
 *
 *   cd solana-alpha && npx tsx src/scripts/paper2-regime-class-branch-backtest.ts \
 *     --pm2-pt1-oscar-env --since-hours 2000 --max-trades 120 --jsonl data/live/pt1-oscar-live.jsonl
 *
 * Env: как у Oscar paper (`PAPER_*`). Нужен DATABASE_URL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import { overridesForRegime, stampTpRegimeAtHistoricalEntry } from '../papertrader/pricing/tp-regime.js';
import type { OpenTrade } from '../papertrader/types.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import { cloneOpenFromJournal, simulateLifecycle } from './paper2-strategy-backtest.js';
import { scanJournal, type ClosedPair } from './paper2-loss-attribution-deep-dive.js';
import { pm2Pt1OscarEnv, withEnvPatch } from './paper2-scenario-tp-trail-optimize.js';

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

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchMintPriceAnchorsPg(args: {
  mint: string;
  source: string;
  entryTs: number;
  endTs: number;
}): Promise<Anchor[]> {
  const table = sourceSnapshotTable(args.source);
  if (!table) return [];
  const mint = sqlQuote(args.mint);
  const t0 = args.entryTs / 1000;
  const t1 = args.endTs / 1000;
  const q = `
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::double precision AS ts_ms,
           price_usd::double precision AS p
    FROM ${table}
    WHERE base_mint = ${mint}
      AND ts >= to_timestamp(${t0})
      AND ts <= to_timestamp(${t1})
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Array<{ ts_ms: unknown; p: unknown }>;
  const out: Anchor[] = [];
  for (const row of rows) {
    const ts = Number(row.ts_ms);
    const p = Number(row.p);
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) continue;
    out.push({ ts, p });
  }
  return out;
}

function rowKey(p: ClosedPair): string {
  return `${p.mint}:${p.entryTs}:${p.exitTs}`;
}

function dedupePairs(pairs: ClosedPair[]): ClosedPair[] {
  const seen = new Set<string>();
  const out: ClosedPair[] = [];
  for (const p of pairs) {
    const k = rowKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function stripRegimeFields(open: Record<string, unknown>): Record<string, unknown> {
  const raw = { ...open };
  delete raw.tpRegime;
  delete raw.tpGridOverrides;
  delete raw.tpRegimeFeatures;
  return raw;
}

type Bucket = 'down' | 'sideways' | 'up' | 'unknown';

function applySymbiosisOverrides(args: {
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  regime: Bucket;
  hadAvgDown: boolean;
}): void {
  const { ot, cfg, regime, hadAvgDown } = args;
  if (regime === 'down') {
    ot.tpGridOverrides = overridesForRegime('down', cfg);
    return;
  }
  if (regime === 'sideways') {
    ot.tpGridOverrides = hadAvgDown ? overridesForRegime('down', cfg) : undefined;
    return;
  }
  ot.tpGridOverrides = undefined;
}

function applyDualDownOverrides(args: {
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  regime: Bucket;
  hadAvgDown: boolean;
}): void {
  const { ot, cfg, regime, hadAvgDown } = args;
  if (regime === 'down') {
    ot.tpGridOverrides = hadAvgDown ? overridesForRegime('down', cfg) : undefined;
    return;
  }
  ot.tpGridOverrides = overridesForRegime(regime === 'unknown' ? 'unknown' : regime, cfg);
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 720);
  const stepMs = Number(arg('--step-ms') ?? 30_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);
  const maxTrades = Number(arg('--max-trades') ?? 500);
  const strategySubstr = arg('--strategy-substr');

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
    console.error('Provide --jsonl and/or --dir');
    process.exit(1);
  }

  const usePm2Oscar = process.argv.includes('--pm2-pt1-oscar-env');

  let cfg: PaperTraderConfig;
  let dcaLevels: ReturnType<typeof parseDcaLevels>;
  let tpLadder: ReturnType<typeof parseTpLadder>;
  try {
    if (usePm2Oscar) {
      const oscarEnv = pm2Pt1OscarEnv();
      const bundle = withEnvPatch(oscarEnv, () => ({
        cfg: loadPaperTraderConfig(),
        dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
        tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
      }));
      cfg = bundle.cfg;
      dcaLevels = bundle.dcaLevels;
      tpLadder = bundle.tpLadder;
    } else {
      cfg = loadPaperTraderConfig();
      dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS);
      tpLadder = parseTpLadder(process.env.PAPER_TP_LADDER);
    }
  } catch (e) {
    console.error('loadPaperTraderConfig:', (e as Error).message);
    if (usePm2Oscar) {
      console.error('(Проверь ecosystem.config.cjs: блок env для pt1-oscar)');
    }
    process.exit(1);
  }

  const sinceCloseMs = Date.now() - sinceH * 3_600_000;
  const pairsRaw: ClosedPair[] = [];
  for (const p of paths) {
    pairsRaw.push(...(await scanJournal(p, sinceCloseMs)));
  }
  let pairs = dedupePairs(pairsRaw);
  if (strategySubstr) {
    pairs = pairs.filter((p) => {
      const o = p.openTrade as Record<string, unknown>;
      return String(o.strategyId ?? o.strategy_id ?? '').includes(strategySubstr);
    });
  }
  pairs.sort((a, b) => b.exitTs - a.exitTs);
  if (Number.isFinite(maxTrades) && maxTrades > 0) {
    pairs = pairs.slice(0, maxTrades);
  }

  console.log(`\n=== TP regime class × avg-down branch backtest ===`);
  console.log(`Env: ${usePm2Oscar ? 'ecosystem pt1-oscar (PM2 parity)' : 'process.env / .env as loaded'}`);
  console.log(`Journal files: ${paths.length}  closes (deduped, capped): ${pairs.length}`);
  console.log(
    `Regime PG lookback: ${cfg.tpRegimeLookbackMin}m @ entry | sim stepMs=${stepMs} timeout=${cfg.timeoutHours}h gridStep=${cfg.tpGridStepPnl}\n`,
  );

  type Row = {
    regime: Bucket;
    hadAvgDown: boolean;
    realized: number;
    simFlat: number | null;
    simEntryReg: number | null;
    simSym: number | null;
    simDualDown: number | null;
  };
  const rows: Row[] = [];

  let nSkipSrc = 0;
  let nSkipClone = 0;
  let nSkipPg = 0;

  for (const pair of pairs) {
    const openRaw = pair.openTrade as Record<string, unknown>;
    const hadAvgDown = pair.hadAvgDown === true;

    const src = String(openRaw.source ?? '').trim();
    if (!src || !sourceSnapshotTable(src)) {
      nSkipSrc++;
      continue;
    }

    const stripped = stripRegimeFields(openRaw);
    let otBase: OpenTrade;
    try {
      otBase = cloneOpenFromJournal(stripped);
    } catch {
      nSkipClone++;
      continue;
    }

    const otLabel = cloneOpenFromJournal(stripped);
    await stampTpRegimeAtHistoricalEntry(cfg, otLabel);
    const regime = (otLabel.tpRegime ?? 'unknown') as Bucket;

    const endTs = otBase.entryTs + (cfg.timeoutHours + bufferHours) * 3_600_000;
    const anchors = await fetchMintPriceAnchorsPg({
      mint: otBase.mint,
      source: src,
      entryTs: otBase.entryTs,
      endTs,
    });
    if (anchors.length < 2) {
      nSkipPg++;
      rows.push({
        regime,
        hadAvgDown,
        realized: pair.netUsd,
        simFlat: null,
        simEntryReg: null,
        simSym: null,
        simDualDown: null,
      });
      continue;
    }

    const otFlat = cloneOpenFromJournal(stripped);
    delete otFlat.tpRegime;
    delete otFlat.tpGridOverrides;
    delete otFlat.tpRegimeFeatures;

    const otEntryReg = cloneOpenFromJournal(stripped);
    await stampTpRegimeAtHistoricalEntry(cfg, otEntryReg);

    const otSym = cloneOpenFromJournal(stripped);
    otSym.tpRegime = otLabel.tpRegime;
    otSym.tpRegimeFeatures = otLabel.tpRegimeFeatures;
    applySymbiosisOverrides({ ot: otSym, cfg, regime, hadAvgDown });

    const otDualDown = cloneOpenFromJournal(stripped);
    otDualDown.tpRegime = otLabel.tpRegime;
    otDualDown.tpRegimeFeatures = otLabel.tpRegimeFeatures;
    applyDualDownOverrides({ ot: otDualDown, cfg, regime, hadAvgDown });

    const ctFlat = simulateLifecycle({
      baseOt: otFlat,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    const ctEntryReg = simulateLifecycle({
      baseOt: otEntryReg,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    const ctSym = simulateLifecycle({
      baseOt: otSym,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    const ctDualDown = simulateLifecycle({
      baseOt: otDualDown,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });

    rows.push({
      regime,
      hadAvgDown,
      realized: pair.netUsd,
      simFlat: ctFlat ? ctFlat.netPnlUsd : null,
      simEntryReg: ctEntryReg ? ctEntryReg.netPnlUsd : null,
      simSym: ctSym ? ctSym.netPnlUsd : null,
      simDualDown: ctDualDown ? ctDualDown.netPnlUsd : null,
    });
  }

  const ok = rows.filter((r) => r.simFlat != null && r.simEntryReg != null && r.simSym != null && r.simDualDown != null);

  const buckets: Bucket[] = ['down', 'sideways', 'up', 'unknown'];

  console.log(`--- A) Журнал: доля сделок с усреднением (dca/scale-in) по классу входа ---`);
  for (const b of buckets) {
    const sub = rows.filter((r) => r.regime === b);
    const withAvg = sub.filter((r) => r.hadAvgDown).length;
    const pct = sub.length ? (100 * withAvg) / sub.length : 0;
    console.log(`  ${b.padEnd(10)} n=${String(sub.length).padStart(4)}  hadAvgDown=${String(withAvg).padStart(4)} (${pct.toFixed(1)}%)`);
  }

  function sumPred(pred: (r: (typeof ok)[0]) => boolean, pick: (r: (typeof ok)[0]) => number): number {
    let s = 0;
    for (const r of ok) {
      if (pred(r)) s += pick(r);
    }
    return s;
  }

  function line(label: string, pred: (r: (typeof ok)[0]) => boolean): void {
    const n = ok.filter(pred).length;
    const sFlat = sumPred((r) => pred(r), (r) => r.simFlat!);
    const sEr = sumPred((r) => pred(r), (r) => r.simEntryReg!);
    const sSy = sumPred((r) => pred(r), (r) => r.simSym!);
    const sDd = sumPred((r) => pred(r), (r) => r.simDualDown!);
    const dSy = sSy - sEr;
    const dDd = sDd - sEr;
    console.log(
      `  ${label.padEnd(14)} n=${String(n).padStart(4)}  flat=$${sFlat.toFixed(2).padStart(9)}  entryReg=$${sEr.toFixed(2).padStart(9)}  sym=$${sSy.toFixed(2).padStart(9)} (Δ${dSy >= 0 ? '+' : ''}${dSy.toFixed(2)})  dualDown=$${sDd.toFixed(2).padStart(9)} (Δ${dDd >= 0 ? '+' : ''}${dDd.toFixed(2)})`,
    );
  }

  console.log(`\n--- B) PG replay (полный путь): flat vs entryReg vs symbiosis vs dualDown ---`);
  console.log(`  Полные симы: n=${ok.length} (из ${rows.length} строк журнала)`);
  line('ALL', () => true);
  for (const b of buckets) {
    line(b, (r) => r.regime === b);
  }

  console.log(`\n--- C) Только sideways: ветка по факту усреднения (для интерпретации symbiosis) ---`);
  line('sw+avg', (r) => r.regime === 'sideways' && r.hadAvgDown);
  line('sw no avg', (r) => r.regime === 'sideways' && !r.hadAvgDown);

  console.log(`\n--- D) Только down: ветка по факту усреднения (для интерпретации dualDown) ---`);
  line('dn+avg', (r) => r.regime === 'down' && r.hadAvgDown);
  line('dn no avg', (r) => r.regime === 'down' && !r.hadAvgDown);

  console.log(`\n--- E) Как читать ---`);
  console.log(`  • sym Δ vs entryReg по классу **sideways**: если стабильно >0 — «два режима» (усреднение→скальп, иначе flat) лучше, чем фиксированные sideways-overrides (max 2 rungs).`);
  console.log(`  • dualDown Δ по классу **down**: если >0 — имело бы смысл **не** жать скальпом сделки без фактического усреднения (оставить flat). Обратный знак — однотипный даун-профиль на все даун-входы лучше на этой выборке.`);
  console.log(`  • Малый n → вывод «точно» невозможен; гоняйте тот же скрипт на большем окне jsonl / нескольких файлах.`);

  console.log(`\nSkipped: no snapshot source=${nSkipSrc} clone_fail=${nSkipClone} pg_sparse=${nSkipPg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
