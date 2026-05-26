/**
 * Shared Jupiter SOL→token spot refresh for discovery rows (in-memory only).
 */
import { getSolUsd } from '../pricing.js';
import { scaleMcapWithPrice } from '../pricing/mcap-snapshot.js';
import type { PaperTraderConfig } from '../config.js';
import { quoteResilienceFromPaperCfg } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { jupiterQuoteBuyPriceUsd } from '../pricing/price-verify.js';

export type JupiterSpotRefreshResult = {
  refreshed: number;
  skipped: number;
  errors: number;
};

export type JupiterSpotRefreshOptions = {
  /** Only apply quote when tradable price is below PG snapshot (deeper dip / lower entry split band). */
  onlyIfLowerThanSnapshot?: boolean;
  /** Per-row guard after quote; return false to skip applying price. */
  acceptPrice?: (row: SnapshotCandidateRow, jupiterPx: number, snapshotPx: number) => boolean;
  /** Skip `priorityDiscoveryJupiterRefreshEnabled` gate (volume-leader cross-check tier). */
  bypassPriorityJupiterGate?: boolean;
  /** Skip apply when |Δ%| below this (noise). 0 = off. */
  minApplyDivergencePct?: number;
  /** Skip apply when |Δ%| above this (wild PG/Jupiter mismatch). */
  maxApplyDivergencePct?: number;
  onApplied?: (row: SnapshotCandidateRow) => void;
};

function defaultAccept(): boolean {
  return true;
}

/**
 * Refresh `row.price_usd` from Jupiter buy quote for mints matching `mintFilter`.
 */
export async function refreshRowsPricesFromJupiter(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  mintFilter: (row: SnapshotCandidateRow) => boolean,
  maxPerTick: number,
  options?: JupiterSpotRefreshOptions,
): Promise<JupiterSpotRefreshResult> {
  const result: JupiterSpotRefreshResult = { refreshed: 0, skipped: 0, errors: 0 };
  const jupiterGateOk = options?.bypassPriorityJupiterGate
    ? true
    : cfg.priorityDiscoveryJupiterRefreshEnabled;
  if (!jupiterGateOk || maxPerTick <= 0 || rows.length === 0) {
    result.skipped += rows.filter(mintFilter).length;
    return result;
  }

  const solUsd = getSolUsd();
  if (!(solUsd > 0)) {
    result.skipped += rows.filter(mintFilter).length;
    return result;
  }

  const probeUsd = Math.min(50, Math.max(10, cfg.positionUsd * 0.05));
  const resilience = quoteResilienceFromPaperCfg(cfg);
  let done = 0;

  for (const row of rows) {
    if (!mintFilter(row)) continue;
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
      if (q.kind !== 'ok' || q.jupiterPriceUsd == null || !(q.jupiterPriceUsd > 0)) {
        result.skipped += 1;
        continue;
      }

      const jpx = q.jupiterPriceUsd;
      if (options?.onlyIfLowerThanSnapshot && !(jpx < snapPx - 1e-18)) {
        result.skipped += 1;
        continue;
      }

      const divPct = (Math.abs(jpx - snapPx) / snapPx) * 100;
      const minDiv = options?.minApplyDivergencePct ?? 0;
      const maxDiv = options?.maxApplyDivergencePct;
      if (minDiv > 0 && divPct + 1e-12 < minDiv) {
        result.skipped += 1;
        continue;
      }
      if (maxDiv != null && maxDiv > 0 && divPct > maxDiv + 1e-12) {
        result.skipped += 1;
        continue;
      }

      const accept = options?.acceptPrice ?? defaultAccept;
      if (!accept(row, jpx, snapPx)) {
        result.skipped += 1;
        continue;
      }

      const oldMcap = Number(row.market_cap_usd ?? 0);
      row.price_usd = jpx;
      if (oldMcap > 0) {
        const scaled = scaleMcapWithPrice(snapPx, jpx, oldMcap);
        if (scaled != null && scaled > 0) row.market_cap_usd = scaled;
      }
      result.refreshed += 1;
      options?.onApplied?.(row);
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
