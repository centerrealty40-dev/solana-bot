/**
 * Jupiter spot refresh for priority discovery mints — ловит тихие проливы между PG minute buckets.
 */
import { getSolUsd } from '../pricing.js';
import type { PaperTraderConfig } from '../config.js';
import { quoteResilienceFromPaperCfg } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { jupiterQuoteBuyPriceUsd } from '../pricing/price-verify.js';

export type PriorityPriceRefreshResult = {
  refreshed: number;
  skipped: number;
  errors: number;
};

/**
 * Обновляет `row.price_usd` свежим Jupiter quote (SOL→mint) для priority mint'ов.
 * Не пишет в PG — только in-memory row перед dip-eval на этом тике.
 */
export async function refreshPriorityMintPricesFromJupiter(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  priorityMintSet: ReadonlySet<string>,
): Promise<PriorityPriceRefreshResult> {
  const result: PriorityPriceRefreshResult = { refreshed: 0, skipped: 0, errors: 0 };
  if (!cfg.priorityDiscoveryEnabled || !cfg.priorityDiscoveryJupiterRefreshEnabled) return result;
  if (priorityMintSet.size === 0 || rows.length === 0) return result;

  const solUsd = getSolUsd();
  if (!(solUsd > 0)) {
    result.skipped += rows.length;
    return result;
  }

  const maxPerTick = cfg.priorityDiscoveryJupiterRefreshMaxPerTick;
  const probeUsd = Math.min(50, Math.max(10, cfg.positionUsd * 0.05));
  const resilience = quoteResilienceFromPaperCfg(cfg);
  let done = 0;

  for (const row of rows) {
    if (!priorityMintSet.has(row.mint)) continue;
    if (done >= maxPerTick) {
      result.skipped += 1;
      continue;
    }
    done += 1;

    const snapPx = Number(row.price_usd);
    if (!(snapPx > 0)) {
      result.skipped += 1;
      continue;
    }

    try {
      const q = await jupiterQuoteBuyPriceUsd({
        mint: row.mint,
        outMintDecimals: 6,
        sizeUsd: probeUsd,
        solUsd,
        snapshotPriceUsd: snapPx,
        slippageBps: cfg.slippageBpsPerSide,
        timeoutMs: cfg.priceVerifyTimeoutMs,
        resilience,
      });
      if (q.kind === 'ok' && q.jupiterPriceUsd != null && q.jupiterPriceUsd > 0) {
        row.price_usd = q.jupiterPriceUsd;
        result.refreshed += 1;
      } else {
        result.skipped += 1;
      }
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
