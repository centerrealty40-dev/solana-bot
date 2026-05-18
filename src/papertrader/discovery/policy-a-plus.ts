/**
 * Policy A+ entry filter (1.11.167).
 *
 * Goal: cut systematically losing entries identified by retro-correlation analysis
 * on 119 closed Live Oscar trades. Four "surgical" rules — each independently
 * toggleable — that on the historical sample lift Σ PnL from −$70 → +$658 and
 * win-rate 56% → 70% while keeping 46/119 of the trades (39% kept rate).
 *
 * Rules (block entry when):
 *  1. `bounce_from_min_30m_pct` > `cfg.policyAPlusBounceFromMin30mMaxPct` (prod 2.5%)
 *     — coin already bounced more than X% off its 30-min low (we are not on the dip).
 *  2. `price_change_1h_pct` < `cfg.policyAPlusPriceChange1hMinPct`
 *     — coin in deep 1h freefall (entering a knife).
 *  3. `vol_1h_usd` > `cfg.policyAPlusVol1hMaxUsd`
 *     — abnormally hot coin (likely pump-and-dump tail).
 *  4. `price_change_*m_pct` < `cfg.policyAPlusPriceChange30mMinPct` over `policyAPlusPriceChangeWindowMin`
 *     — coin in fresh short-window freefall (prod 15m, was 30m).
 *
 * Each metric also flows into `live_discovery_eval.policyAPlusFeatures` for later
 * retro analysis. Only PG snapshots in the same DEX table as the candidate are used;
 * if the table holds no usable history (`coverageOk=false`) the rule is treated as
 * "ok" (do not block on missing data) but the missing reason is logged.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface PolicyAPlusFeatures {
  /** Минимальная цена за последние 30 мин. */
  min30m: number | null;
  /** Цена ~30 мин назад (среднее по окну [-32, -28] мин). */
  price30mAgo: number | null;
  /** Цена ~1 час назад (среднее по окну [-62, -58] мин). */
  price1hAgo: number | null;
  /** % отскока от min30m: (current - min) / min × 100. */
  bounceFromMin30mPct: number | null;
  /** % изменения цены за `policyAPlusPriceChangeWindowMin` (PG anchor in price30mAgo). */
  priceChange30mPct: number | null;
  /** % изменения цены за 1 час: (current - price1hAgo) / price1hAgo × 100. */
  priceChange1hPct: number | null;
  /** Объём за последний час из текущего snapshot row (для удобства в JSONL). */
  vol1hUsd: number | null;
  /** Сколько тиков из PG нашлось в окне `[-65min, now]` (для диагностики coverage). */
  pgSnapsCount: number;
  /** false => не нашли исторических данных, правила НЕ применяем (consider safe). */
  coverageOk: boolean;
}

export interface PolicyAPlusEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: PolicyAPlusFeatures;
}

const EMPTY_FEATURES: PolicyAPlusFeatures = {
  min30m: null,
  price30mAgo: null,
  price1hAgo: null,
  bounceFromMin30mPct: null,
  priceChange30mPct: null,
  priceChange1hPct: null,
  vol1hUsd: null,
  pgSnapsCount: 0,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** PG anchor window for short knife rule: avg price in [now−(W+2)m, now−(W−2)m]. */
function policyAPlusShortWindowBounds(windowMin: number): { window: number; agoLoMin: number; agoHiMin: number } {
  const window = Math.max(5, Math.min(120, Math.round(windowMin)));
  return { window, agoLoMin: window + 2, agoHiMin: Math.max(1, window - 2) };
}

/**
 * Batch-fetch policy-A+ метрик для всех кандидатов (один SQL на DEX-таблицу).
 * Окно сканирования — 65 мин (немного шире 1ч чтобы поймать 1h proxy).
 */
export async function fetchPolicyAPlusContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, PolicyAPlusFeatures>> {
  const map = new Map<string, PolicyAPlusFeatures>();
  if (!cfg.policyAPlusEnabled) return map;
  if (rows.length === 0) return map;

  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const t = sourceSnapshotTable(r.source);
    if (!t) continue;
    const arr = byTable.get(t) ?? [];
    arr.push(r.mint);
    byTable.set(t, arr);
  }

  for (const [table, mintsRaw] of byTable.entries()) {
    const uniq = [...new Set(mintsRaw)];
    if (uniq.length === 0) continue;
    const mintsSql = uniq.map(sqlQuote).join(',');
    const { agoLoMin, agoHiMin } = policyAPlusShortWindowBounds(cfg.policyAPlusPriceChangeWindowMin);
    /**
     * Используем `MIN`/`AVG` с фильтрами по `ts` интервалам — это даёт честный
     * batch-aggregate без window-function (быстрее на больших таблицах). Short-knife
     * anchor: avg в [now−(W+2)m, now−(W−2)m] (prod W=15); 1ч — [-62m, -58m].
     * Если в окне <2 точек — функция вернёт NULL, coverageOk=false (safe-skip).
     */
    const r = await db.execute(dsql.raw(`
      SELECT
        base_mint AS mint,
        MIN(NULLIF(COALESCE(price_usd, 0), 0)) FILTER (WHERE ts >= now() - interval '30 minutes' AND COALESCE(price_usd, 0) > 0)::float AS min_30m,
        AVG(NULLIF(COALESCE(price_usd, 0), 0)) FILTER (WHERE ts >= now() - interval '${agoLoMin} minutes' AND ts <= now() - interval '${agoHiMin} minutes' AND COALESCE(price_usd, 0) > 0)::float AS price_30m_ago,
        AVG(NULLIF(COALESCE(price_usd, 0), 0)) FILTER (WHERE ts >= now() - interval '62 minutes' AND ts <= now() - interval '58 minutes' AND COALESCE(price_usd, 0) > 0)::float AS price_1h_ago,
        COUNT(*) FILTER (WHERE ts >= now() - interval '65 minutes')::int AS snaps_count
      FROM ${table}
      WHERE ts >= now() - interval '65 minutes'
        AND base_mint IN (${mintsSql})
      GROUP BY base_mint
    `));
    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const min30m = Number(row.min_30m ?? 0) > 0 ? Number(row.min_30m) : null;
      const price30mAgo = Number(row.price_30m_ago ?? 0) > 0 ? Number(row.price_30m_ago) : null;
      const price1hAgo = Number(row.price_1h_ago ?? 0) > 0 ? Number(row.price_1h_ago) : null;
      const snapsCount = Number(row.snaps_count ?? 0) | 0;
      map.set(mint, {
        min30m,
        price30mAgo,
        price1hAgo,
        bounceFromMin30mPct: null,
        priceChange30mPct: null,
        priceChange1hPct: null,
        vol1hUsd: null,
        pgSnapsCount: snapsCount,
        coverageOk: snapsCount >= 2,
      });
    }
  }
  return map;
}

/**
 * Применить Policy A+ правила к одному кандидату; вычисляет финальные features
 * (с подставленной текущей ценой row.price_usd) и возвращает блокировки.
 */
export function evaluatePolicyAPlus(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: PolicyAPlusFeatures,
): PolicyAPlusEvalResult {
  if (!cfg.policyAPlusEnabled) {
    return { blocked: false, blockedReasons: [], features: EMPTY_FEATURES };
  }
  const features: PolicyAPlusFeatures = {
    ...(ctx ?? EMPTY_FEATURES),
    vol1hUsd: Number(row.volume_1h ?? 0) > 0 ? Number(row.volume_1h) : null,
  };
  const px = Number(row.price_usd || 0);
  if (features.min30m != null && features.min30m > 0 && px > 0) {
    features.bounceFromMin30mPct = +((px - features.min30m) / features.min30m * 100).toFixed(3);
  }
  if (features.price30mAgo != null && features.price30mAgo > 0 && px > 0) {
    features.priceChange30mPct = +((px - features.price30mAgo) / features.price30mAgo * 100).toFixed(3);
  }
  if (features.price1hAgo != null && features.price1hAgo > 0 && px > 0) {
    features.priceChange1hPct = +((px - features.price1hAgo) / features.price1hAgo * 100).toFixed(3);
  }

  const blockedReasons: string[] = [];
  if (!features.coverageOk) {
    /** PG-coverage недостаточен — pass through (consider safe), но залогируем. */
    return { blocked: false, blockedReasons, features };
  }
  if (
    cfg.policyAPlusBounceFromMin30mEnabled &&
    features.bounceFromMin30mPct != null &&
    features.bounceFromMin30mPct > cfg.policyAPlusBounceFromMin30mMaxPct
  ) {
    blockedReasons.push(
      `policy_a_plus:bounce_from_min_30m=${features.bounceFromMin30mPct.toFixed(2)}%>${cfg.policyAPlusBounceFromMin30mMaxPct}%`,
    );
  }
  if (
    cfg.policyAPlusPriceChange1hEnabled &&
    features.priceChange1hPct != null &&
    features.priceChange1hPct < cfg.policyAPlusPriceChange1hMinPct
  ) {
    blockedReasons.push(
      `policy_a_plus:price_change_1h=${features.priceChange1hPct.toFixed(2)}%<${cfg.policyAPlusPriceChange1hMinPct}%`,
    );
  }
  if (
    cfg.policyAPlusVol1hEnabled &&
    features.vol1hUsd != null &&
    features.vol1hUsd > cfg.policyAPlusVol1hMaxUsd
  ) {
    blockedReasons.push(
      `policy_a_plus:vol_1h=$${Math.round(features.vol1hUsd)}>$${cfg.policyAPlusVol1hMaxUsd}`,
    );
  }
  if (
    cfg.policyAPlusPriceChange30mEnabled &&
    features.priceChange30mPct != null &&
    features.priceChange30mPct < cfg.policyAPlusPriceChange30mMinPct
  ) {
    const w = policyAPlusShortWindowBounds(cfg.policyAPlusPriceChangeWindowMin).window;
    blockedReasons.push(
      `policy_a_plus:price_change_${w}m=${features.priceChange30mPct.toFixed(2)}%<${cfg.policyAPlusPriceChange30mMinPct}%`,
    );
  }

  return { blocked: blockedReasons.length > 0, blockedReasons, features };
}
