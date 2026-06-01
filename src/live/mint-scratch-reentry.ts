/**
 * Live Oscar — price-based mint re-entry after harvest/scratch exit (no time cooldown).
 * Re-entry allowed when candidate price ≤ lastExitRef × (1 − dropPct).
 * v2 hybrid: ref = avg entry after TP +5% harvest; v3 scratch: ref = last exit price.
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

/** Mint has a harvest/scratch exit ref and candidate price is at or below ref×(1−drop). */
export function isMintScratchReentryEntryReady(
  liveCfg: LiveOscarConfig,
  mint: string,
  candidatePriceUsd: number,
): boolean {
  if (!liveCfg.liveMintScratchReentryEnabled) return false;
  const ref = mintScratchReentryRefPrice(mint);
  if (ref == null || !(candidatePriceUsd > 0)) return false;
  return !isMintScratchReentryBlocked(liveCfg, mint, candidatePriceUsd);
}

/** Ref set but price still above re-entry threshold — block normal dip entry until drop. */
export function isMintScratchReentryAwaitingPriceDrop(
  liveCfg: LiveOscarConfig,
  mint: string,
  candidatePriceUsd: number,
): boolean {
  if (!liveCfg.liveMintScratchReentryEnabled) return false;
  const ref = mintScratchReentryRefPrice(mint);
  if (ref == null || !(candidatePriceUsd > 0)) return false;
  return isMintScratchReentryBlocked(liveCfg, mint, candidatePriceUsd);
}

function scratchReentryCfg(): LiveOscarConfig | null {
  return cfgRef;
}

/** Discovery: entry ready using module cfg from `configureMintScratchReentry`. */
export function isMintScratchReentryEntryReadyForDiscovery(mint: string, candidatePriceUsd: number): boolean {
  const cfg = scratchReentryCfg();
  return cfg != null && isMintScratchReentryEntryReady(cfg, mint, candidatePriceUsd);
}

export function isMintScratchReentryAwaitingPriceDropForDiscovery(
  mint: string,
  candidatePriceUsd: number,
): boolean {
  const cfg = scratchReentryCfg();
  return cfg != null && isMintScratchReentryAwaitingPriceDrop(cfg, mint, candidatePriceUsd);
}

/** Discovery / paper: append gate reason when price is above re-entry threshold. */
export function appendMintScratchReentryGateReasons(
  mint: string,
  candidatePriceUsd: number,
  out: string[],
): void {
  const cfg = cfgRef;
  if (!cfg?.liveMintScratchReentryEnabled) return;
  if (!isMintScratchReentryBlocked(cfg, mint, candidatePriceUsd)) return;
  const ref = mintScratchReentryRefPrice(mint);
  const drop = cfg.liveMintScratchReentryDropPct;
  const threshold = ref != null ? ref * (1 - drop) : null;
  out.push(
    `mint_scratch_reentry_price(ref=${ref?.toFixed(8) ?? '?'} need<=${threshold?.toFixed(8) ?? '?'} snap=${candidatePriceUsd.toFixed(8)} drop=${(drop * 100).toFixed(0)}%)`,
  );
}

export function resetMintScratchReentryForTests(): void {
  lastExitRefPriceUsdByMint.clear();
}
