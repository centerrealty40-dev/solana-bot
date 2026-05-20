/**
 * Runner Mode (1.11.232) — параллельный к dip-windows путь discovery.
 *
 * Цель: ловить «магниты открытого интереса» — монеты, в которые прямо сейчас уходит
 * поток retail-внимания и денег. В отличие от dip-режима, не требует -20% коррекции
 * и не упирается в свежесть пула: 3-месячная монета, у которой сегодня всплеск, —
 * такой же runner, как pump.fun, родившийся 2 часа назад. Решающий фактор —
 * **динамика объёма/ликвидности/чистого buy-flow** за окна 1ч/12ч/24ч, а не
 * возраст pool/holders/dip-windows.
 *
 * Никаких holder-проверок: пользователь явно отказался от них как от ненадёжного сигнала.
 * Никаких age-фильтров: «протухание» определяется только через убыль интереса.
 *
 * Anti-stale (отсечь TripleT-подобные): если vol_1h меньше, чем `vol_24h/24 × ratio`,
 * значит внимание утекает — отказ. Аналогично если ликвидность ушла относительно
 * 24-часовой p25 — отказ.
 *
 * Этот модуль НЕ заменяет dip-фильтр и НЕ переопределяет existing snapshot/policy
 * floor. Он включается как параллельный entryPath='runner' в discovery loop;
 * dip-логика продолжает работать независимо.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';

export interface RunnerWindowFeatures {
  /** Объём (USD) за последний час, суммированный по всем DEX-таблицам. */
  vol1hUsd: number;
  /** Объём за 12ч (USD). */
  vol12hUsd: number;
  /** Объём за 24ч (USD). */
  vol24hUsd: number;
  /** Средний часовой объём за 24ч = vol_24h / 24 (USD). */
  vol1hAvg24hUsd: number;
  /** Часовая velocity: vol_1h / vol_1h_avg_24h (1.0 = «как обычно», >1.5 = разгон). */
  vol1hVelocity: number | null;
  /** Buys count за последний час (сумма по DEX). */
  buys1h: number;
  /** Sells count за последний час. */
  sells1h: number;
  /** Buys/Sells за 1h (>1.0 = покупки доминируют). */
  bs1h: number | null;
  /** Buys за 12ч. */
  buys12h: number;
  /** Sells за 12ч. */
  sells12h: number;
  /** Buys/Sells за 12ч (кумулятивный тренд). */
  bs12h: number | null;
  /** Максимальный 5-минутный объём за последний час (USD) — индикатор bursty flow. */
  vol5mPeak1hUsd: number;
  /** Текущая liq из snapshot row (передаётся снаружи). */
  liqNowUsd: number;
  /** p25 ликвидности за 24ч — нижняя граница «нормального уровня». */
  liqP25_24hUsd: number | null;
  /** p50 ликвидности за 24ч. */
  liqP50_24hUsd: number | null;
  /** Текущий mcap из snapshot row. */
  mcapNowUsd: number;
  /** Максимальный mcap за 24ч. */
  mcapMax24hUsd: number | null;
  /** Текущая цена. */
  priceNowUsd: number;
  /** Максимальная цена за 24ч. */
  priceMax24hUsd: number | null;
  /** Сколько PG-строк нашлось за 24ч (диагностика покрытия). */
  pgSamples24h: number;
  /** Если покрытия нет (sample_count < минимума) — runner mode выключается, не блокируем. */
  coverageOk: boolean;
}

export interface RunnerEvalResult {
  pass: boolean;
  /** Причины отказа; пусто если pass=true. */
  reasons: string[];
  features: RunnerWindowFeatures;
}

const EMPTY_FEATURES: RunnerWindowFeatures = {
  vol1hUsd: 0,
  vol12hUsd: 0,
  vol24hUsd: 0,
  vol1hAvg24hUsd: 0,
  vol1hVelocity: null,
  buys1h: 0,
  sells1h: 0,
  bs1h: null,
  buys12h: 0,
  sells12h: 0,
  bs12h: null,
  vol5mPeak1hUsd: 0,
  liqNowUsd: 0,
  liqP25_24hUsd: null,
  liqP50_24hUsd: null,
  mcapNowUsd: 0,
  mcapMax24hUsd: null,
  priceNowUsd: 0,
  priceMax24hUsd: null,
  pgSamples24h: 0,
  coverageOk: false,
};

function sqlQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

const RUNNER_DEX_TABLES = [
  'pumpswap_pair_snapshots',
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'moonshot_pair_snapshots',
  'orca_pair_snapshots',
];

interface RunnerAggRow {
  mint: string;
  vol_1h: number | null;
  vol_12h: number | null;
  vol_24h: number | null;
  buys_1h: number | null;
  sells_1h: number | null;
  buys_12h: number | null;
  sells_12h: number | null;
  vol_5m_peak_1h: number | null;
  price_max_24h: number | null;
  mcap_max_24h: number | null;
  liq_p25_24h: number | null;
  liq_p50_24h: number | null;
  sample_rows: number | null;
}

/**
 * Один batch-SQL: UNION ALL по DEX-таблицам за 24ч, агрегация суммами по окнам
 * через FILTER (WHERE ts >= NOW() - INTERVAL '...'). Один tick — один запрос на все mint'ы.
 */
export async function fetchRunnerContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, RunnerWindowFeatures>> {
  const map = new Map<string, RunnerWindowFeatures>();
  if (!cfg.runnerModeEnabled) return map;
  if (rows.length === 0) return map;

  const uniqueMints = [...new Set(rows.map((r) => r.mint))];
  if (uniqueMints.length === 0) return map;
  const mintsSql = uniqueMints.map(sqlQuote).join(',');

  const unionAll = RUNNER_DEX_TABLES.map(
    (t) => `
    SELECT base_mint AS mint, ts,
           COALESCE(price_usd, 0)::float AS price_usd,
           COALESCE(liquidity_usd, 0)::float AS liquidity_usd,
           COALESCE(volume_5m, 0)::float AS volume_5m,
           COALESCE(buys_5m, 0)::int AS buys_5m,
           COALESCE(sells_5m, 0)::int AS sells_5m,
           GREATEST(COALESCE(market_cap_usd, 0), COALESCE(fdv_usd, 0))::float AS mcap_usd
      FROM ${t}
     WHERE base_mint IN (${mintsSql})
       AND ts >= NOW() - INTERVAL '24 hours'
  `,
  ).join('\n    UNION ALL\n');

  const sqlText = `
    WITH rows AS (
${unionAll}
    )
    SELECT
      mint,
      SUM(volume_5m) FILTER (WHERE ts >= NOW() - INTERVAL '1 hour')::float AS vol_1h,
      SUM(volume_5m) FILTER (WHERE ts >= NOW() - INTERVAL '12 hours')::float AS vol_12h,
      SUM(volume_5m)::float AS vol_24h,
      SUM(buys_5m) FILTER (WHERE ts >= NOW() - INTERVAL '1 hour')::int AS buys_1h,
      SUM(sells_5m) FILTER (WHERE ts >= NOW() - INTERVAL '1 hour')::int AS sells_1h,
      SUM(buys_5m) FILTER (WHERE ts >= NOW() - INTERVAL '12 hours')::int AS buys_12h,
      SUM(sells_5m) FILTER (WHERE ts >= NOW() - INTERVAL '12 hours')::int AS sells_12h,
      MAX(volume_5m) FILTER (WHERE ts >= NOW() - INTERVAL '1 hour')::float AS vol_5m_peak_1h,
      MAX(price_usd) FILTER (WHERE price_usd > 0)::float AS price_max_24h,
      MAX(mcap_usd) FILTER (WHERE mcap_usd > 0)::float AS mcap_max_24h,
      percentile_disc(0.25) WITHIN GROUP (ORDER BY liquidity_usd) FILTER (WHERE liquidity_usd > 0)::float AS liq_p25_24h,
      percentile_disc(0.50) WITHIN GROUP (ORDER BY liquidity_usd) FILTER (WHERE liquidity_usd > 0)::float AS liq_p50_24h,
      COUNT(*)::int AS sample_rows
      FROM rows
     GROUP BY mint
  `;

  const r = (await db.execute(dsql.raw(sqlText))) as unknown as RunnerAggRow[];

  const minSamples = Math.max(0, cfg.runnerMinPgSamples24h);
  for (const a of r) {
    const samples = Number(a.sample_rows ?? 0);
    const coverageOk = samples >= minSamples;
    const vol1h = Number(a.vol_1h ?? 0);
    const vol12h = Number(a.vol_12h ?? 0);
    const vol24h = Number(a.vol_24h ?? 0);
    const vol1hAvg = vol24h / 24;
    const buys1h = Number(a.buys_1h ?? 0);
    const sells1h = Number(a.sells_1h ?? 0);
    const buys12h = Number(a.buys_12h ?? 0);
    const sells12h = Number(a.sells_12h ?? 0);
    const f: RunnerWindowFeatures = {
      vol1hUsd: vol1h,
      vol12hUsd: vol12h,
      vol24hUsd: vol24h,
      vol1hAvg24hUsd: vol1hAvg,
      vol1hVelocity: vol1hAvg > 0 ? +(vol1h / vol1hAvg).toFixed(3) : null,
      buys1h,
      sells1h,
      bs1h: sells1h > 0 ? +(buys1h / sells1h).toFixed(3) : buys1h > 0 ? Infinity : null,
      buys12h,
      sells12h,
      bs12h: sells12h > 0 ? +(buys12h / sells12h).toFixed(3) : buys12h > 0 ? Infinity : null,
      vol5mPeak1hUsd: Number(a.vol_5m_peak_1h ?? 0),
      liqNowUsd: 0, // injected by evaluator from snapshot row
      liqP25_24hUsd: a.liq_p25_24h != null ? Number(a.liq_p25_24h) : null,
      liqP50_24hUsd: a.liq_p50_24h != null ? Number(a.liq_p50_24h) : null,
      mcapNowUsd: 0, // injected
      mcapMax24hUsd: a.mcap_max_24h != null ? Number(a.mcap_max_24h) : null,
      priceNowUsd: 0, // injected
      priceMax24hUsd: a.price_max_24h != null ? Number(a.price_max_24h) : null,
      pgSamples24h: samples,
      coverageOk,
    };
    map.set(a.mint, f);
  }
  return map;
}

/**
 * Поэлементный evaluator. row.market_cap_usd/liquidity_usd/price_usd
 * берутся из snapshot row (это «сейчас»); агрегаты — из ctx (PG за 24ч).
 *
 * Возвращает pass=true когда монета — «магнит интереса» сейчас. Каждое условие
 * толкабельно собственным env (см. `PaperTraderConfig.runner*`).
 */
export function evaluateRunner(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx: RunnerWindowFeatures | undefined,
): RunnerEvalResult {
  if (!cfg.runnerModeEnabled) {
    return { pass: false, reasons: ['runner_disabled'], features: EMPTY_FEATURES };
  }

  const f: RunnerWindowFeatures = ctx
    ? {
        ...ctx,
        liqNowUsd: Number(row.liquidity_usd ?? 0),
        mcapNowUsd: Number(row.market_cap_usd ?? 0),
        priceNowUsd: Number(row.price_usd ?? 0),
      }
    : { ...EMPTY_FEATURES };

  const reasons: string[] = [];

  if (!f.coverageOk) {
    reasons.push(`runner_pg_coverage<${cfg.runnerMinPgSamples24h}(${f.pgSamples24h})`);
    return { pass: false, reasons, features: f };
  }

  // --- HARD floors (без них «магнит» не магнит) ---
  if (cfg.runnerMinMcapUsd > 0 && f.mcapNowUsd < cfg.runnerMinMcapUsd) {
    reasons.push(`runner_mcap<${cfg.runnerMinMcapUsd}`);
  }
  if (cfg.runnerMaxMcapUsd > 0 && f.mcapNowUsd > cfg.runnerMaxMcapUsd) {
    reasons.push(`runner_mcap>${cfg.runnerMaxMcapUsd}`);
  }
  if (cfg.runnerMinLiqUsd > 0 && f.liqNowUsd < cfg.runnerMinLiqUsd) {
    reasons.push(`runner_liq<${cfg.runnerMinLiqUsd}`);
  }

  // --- VOLUME velocity (главный сигнал) ---
  if (cfg.runnerMinVol1hUsd > 0 && f.vol1hUsd < cfg.runnerMinVol1hUsd) {
    reasons.push(`runner_vol1h<${cfg.runnerMinVol1hUsd}`);
  }
  if (cfg.runnerMinVol12hUsd > 0 && f.vol12hUsd < cfg.runnerMinVol12hUsd) {
    reasons.push(`runner_vol12h<${cfg.runnerMinVol12hUsd}`);
  }
  if (cfg.runnerVelocityMinX > 0 && f.vol1hVelocity != null && f.vol1hVelocity < cfg.runnerVelocityMinX) {
    reasons.push(`runner_velocity<${cfg.runnerVelocityMinX}x(${f.vol1hVelocity.toFixed(2)}x)`);
  }
  if (cfg.runnerMinVol5mPeak1hUsd > 0 && f.vol5mPeak1hUsd < cfg.runnerMinVol5mPeak1hUsd) {
    reasons.push(`runner_burst<${cfg.runnerMinVol5mPeak1hUsd}`);
  }

  // --- BUY/SELL pressure (внимание retail-а — на стороне покупок) ---
  if (cfg.runnerBs1hMin > 0 && f.bs1h != null && Number.isFinite(f.bs1h) && f.bs1h < cfg.runnerBs1hMin) {
    reasons.push(`runner_bs1h<${cfg.runnerBs1hMin}(${f.bs1h.toFixed(2)})`);
  }
  if (cfg.runnerBs12hMin > 0 && f.bs12h != null && Number.isFinite(f.bs12h) && f.bs12h < cfg.runnerBs12hMin) {
    reasons.push(`runner_bs12h<${cfg.runnerBs12hMin}(${f.bs12h.toFixed(2)})`);
  }

  // --- LIQ stability (ликва не утекла) ---
  if (
    cfg.runnerLiqVsP25Min > 0 &&
    f.liqP25_24hUsd != null &&
    f.liqP25_24hUsd > 0 &&
    f.liqNowUsd < f.liqP25_24hUsd * cfg.runnerLiqVsP25Min
  ) {
    reasons.push(
      `runner_liq_vs_p25<${cfg.runnerLiqVsP25Min}x(now=${Math.round(f.liqNowUsd)}/p25=${Math.round(f.liqP25_24hUsd)})`,
    );
  }

  // --- PRICE hold (монета не -50% от 24h-пика) ---
  if (
    cfg.runnerPriceHoldMin > 0 &&
    f.priceMax24hUsd != null &&
    f.priceMax24hUsd > 0 &&
    f.priceNowUsd / f.priceMax24hUsd < cfg.runnerPriceHoldMin
  ) {
    reasons.push(
      `runner_price<${cfg.runnerPriceHoldMin}x_of_24h_peak(${(f.priceNowUsd / f.priceMax24hUsd).toFixed(2)}x)`,
    );
  }

  // --- ANTI-STALE: TripleT-test ---
  // Если за последний час объём ниже среднего часа за сутки * X — внимание утекает,
  // даже если все остальные пороги выполнены (это «угасание»). Здесь X<1.
  if (
    cfg.runnerStaleVolRatioMax > 0 &&
    f.vol1hAvg24hUsd > 0 &&
    f.vol1hUsd < f.vol1hAvg24hUsd * cfg.runnerStaleVolRatioMax
  ) {
    reasons.push(
      `runner_stale_vol1h<${cfg.runnerStaleVolRatioMax}x_of_avg(${(f.vol1hUsd / f.vol1hAvg24hUsd).toFixed(2)}x)`,
    );
  }

  return { pass: reasons.length === 0, reasons, features: f };
}

/** Helper для тестов и Telegram-alert'а: лаконичная строка-обоснование прохождения. */
export function summariseRunnerPass(f: RunnerWindowFeatures): string {
  const parts: string[] = [];
  parts.push(`vol1h=$${Math.round(f.vol1hUsd / 1000)}k`);
  if (f.vol1hVelocity != null) parts.push(`velocity=${f.vol1hVelocity.toFixed(2)}x`);
  parts.push(`vol12h=$${Math.round(f.vol12hUsd / 1000)}k`);
  if (f.bs1h != null) parts.push(`bs1h=${Number.isFinite(f.bs1h) ? f.bs1h.toFixed(2) : '∞'}`);
  if (f.bs12h != null) parts.push(`bs12h=${Number.isFinite(f.bs12h) ? f.bs12h.toFixed(2) : '∞'}`);
  parts.push(`burst=$${Math.round(f.vol5mPeak1hUsd / 1000)}k`);
  parts.push(`mcap=$${Math.round(f.mcapNowUsd / 1000)}k`);
  parts.push(`liq=$${Math.round(f.liqNowUsd / 1000)}k`);
  if (f.priceMax24hUsd && f.priceMax24hUsd > 0) {
    parts.push(`px_vs_24h_peak=${(f.priceNowUsd / f.priceMax24hUsd).toFixed(2)}x`);
  }
  return parts.join(' ');
}
