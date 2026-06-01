/**
 * Live Oscar Variant A v3 — price-based mint re-entry after scratch exit (no time cooldown).
 * Re-entry allowed when candidate price ≤ lastExitRef × (1 − dropPct).
 */
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';

const log = child('mint-scratch-reentry');

const lastExitRefPriceUsdByMint = new Map<string, number>();

let cfgRef: LiveOscarConfig | null = null;

export function configureMintScratchReentry(liveCfg: LiveOscarConfig): void {
  cfgRef = liveCfg;
}

export function recordMintScratchReentry(mint: string, exitRefPriceUsd: number): void {
  const cfg = cfgRef;
  if (!cfg?.liveMintScratchReentryEnabled) return;
  if (!(exitRefPriceUsd > 0) || !Number.isFinite(exitRefPriceUsd)) return;
  const key = mint.trim();
  if (!key) return;
  lastExitRefPriceUsdByMint.set(key, exitRefPriceUsd);
  appendLiveJsonlEvent({
    kind: 'risk_note',
    reason: 'live_mint_scratch_reentry_ref',
    detail: {
      mint: key,
      exitRefPriceUsd,
      reentryDropPct: cfg.liveMintScratchReentryDropPct,
    },
  });
  log.info(
    { mint: key.slice(0, 12), exitRefPriceUsd, dropPct: cfg.liveMintScratchReentryDropPct },
    'mint scratch re-entry ref set',
  );
}

export function mintScratchReentryRefPrice(mint: string): number | null {
  const v = lastExitRefPriceUsdByMint.get(mint.trim());
  return v != null && v > 0 ? v : null;
}

export function isMintScratchReentryBlocked(
  liveCfg: LiveOscarConfig,
  mint: string,
  candidatePriceUsd: number,
): boolean {
  if (!liveCfg.liveMintScratchReentryEnabled) return false;
  const ref = mintScratchReentryRefPrice(mint);
  if (ref == null || !(candidatePriceUsd > 0)) return false;
  const drop = liveCfg.liveMintScratchReentryDropPct;
  const threshold = ref * (1 - drop);
  return candidatePriceUsd > threshold + 1e-12;
}

export function mintScratchReentryThresholdPrice(mint: string, dropPct: number): number | null {
  const ref = mintScratchReentryRefPrice(mint);
  if (ref == null) return null;
  return ref * (1 - dropPct);
}

/** Test helper — reset in-memory map. */
export function resetMintScratchReentryForTests(): void {
  lastExitRefPriceUsdByMint.clear();
}
