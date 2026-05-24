/**
 * Sanity-проверки pump/retrace паттернов: отсекаем битые бары PG, не реальные проливы.
 */

/** PG bar mcap within reasonable range of price-scaled estimate from ref snapshot. */
export function isBarMcapPlausible(
  barMcapUsd: number | null | undefined,
  barPxUsd: number,
  refMcapUsd: number,
  refPxUsd: number,
  maxRatio = 4,
): boolean {
  if (!(barPxUsd > 0) || !(refMcapUsd > 0) || !(refPxUsd > 0)) {
    return barMcapUsd != null && barMcapUsd > 0;
  }
  const pxVsRef = barPxUsd / refPxUsd;
  if (pxVsRef > 10 || pxVsRef < 0.1) return false;
  const scaled = refMcapUsd * (barPxUsd / refPxUsd);
  if (!(scaled > 0)) return false;
  if (barMcapUsd == null || !(barMcapUsd > 0)) return true;
  const ratio = barMcapUsd / scaled;
  return ratio >= 1 / maxRatio && ratio <= maxRatio;
}

/** Prefer price-scaled mcap when PG bar fdv is inconsistent with ref (e.g. $1.38 px → $1.34B mcap). */
export function resolveBarMcapUsd(args: {
  barPxUsd: number;
  barMcapUsd: number | null | undefined;
  refMcapUsd: number;
  refPxUsd: number;
}): number | null {
  const { barPxUsd, barMcapUsd, refMcapUsd, refPxUsd } = args;
  if (!(barPxUsd > 0)) return null;
  if (refMcapUsd > 0 && refPxUsd > 0) {
    const pxVsRef = barPxUsd / refPxUsd;
    if (pxVsRef > 10 || pxVsRef < 0.1) {
      return refMcapUsd;
    }
    const scaled = refMcapUsd * (barPxUsd / refPxUsd);
    if (barMcapUsd != null && barMcapUsd > 0 && scaled > 0) {
      if (isBarMcapPlausible(barMcapUsd, barPxUsd, refMcapUsd, refPxUsd)) {
        return barMcapUsd;
      }
      return scaled;
    }
    if (scaled > 0) return scaled;
  }
  return barMcapUsd != null && barMcapUsd > 0 ? barMcapUsd : null;
}

/**
 * Jupiter 10s fast-path spike: ghost quote (micro anchor → +50000% pump, or peak >> ref dump).
 */
export function isJupiterGhostSpikeMove(args: {
  anchorPx: number;
  nowPx: number;
  refPx: number;
  refMcap: number;
  pct: number;
}): boolean {
  const { anchorPx, nowPx, refPx, refMcap, pct } = args;
  if (!(refMcap >= 1_000_000) || !(refPx > 0)) return true;
  if (Math.abs(pct) > 200) return true;
  if (anchorPx > 0) {
    const anchorVsRef = anchorPx / refPx;
    if (anchorVsRef > 50 || anchorVsRef < 0.02) return true;
  }
  if (nowPx > 0) {
    const nowVsRef = nowPx / refPx;
    if (nowVsRef > 50 || nowVsRef < 0.02) return true;
  }
  const peakPx = Math.max(anchorPx, nowPx);
  if (isImpossibleMinuteBarSpike(peakPx, refPx, refMcap, Math.abs(pct))) return true;
  return false;
}

/**
 * Minute-bar peak price orders of magnitude above ref on mcap≥$1M token — collector/Jupiter ghost (LAYOFF-like).
 */
export function isImpossibleMinuteBarSpike(
  peakPxUsd: number,
  refPxUsd: number,
  refMcapUsd: number,
  retracePct: number,
): boolean {
  if (retracePct < 50) return false;
  if (!(refPxUsd > 0) || !(peakPxUsd > 0)) return false;
  if (!(refMcapUsd >= 1_000_000)) return false;
  const peakVsRef = peakPxUsd / refPxUsd;
  if (peakVsRef > 50) return true;
  if (peakVsRef > 10 && retracePct >= 85) return true;
  return false;
}

/** Свежий снимок пула не подтверждает заявленный откат (битый бар k на dead pool). */
export function isRetraceContradictedByLatestSnapshot(
  peakPx: number,
  troughPx: number,
  latestPx: number,
  claimedRetracePct: number,
): boolean {
  if (claimedRetracePct < 40) return false;
  if (!(peakPx > 0) || !(latestPx > 0) || !(troughPx > 0)) return false;
  const liveRetracePct = (1 - latestPx / peakPx) * 100;
  if (liveRetracePct + 5 < claimedRetracePct * 0.45) return true;
  if (latestPx > troughPx * 5 && claimedRetracePct >= 50) return true;
  return false;
}

/**
 * Дно ~$1k и пик ~$7M при ref mcap ≥$1M — артефакт первых баров на illiquid pool,
 * не реальный pump+retrace зрелого токена.
 */
export function isMatureTokenMicroValleyArtifact(
  valleyMcapUsd: number | null,
  peakMcapUsd: number | null,
  refMcapUsd: number,
  pumpPct: number,
): boolean {
  if (!(refMcapUsd >= 1_000_000)) return false;
  const peak = peakMcapUsd ?? 0;
  const valley = valleyMcapUsd ?? 0;
  if (!(peak >= 500_000)) return false;
  if (valley > 300_000) return false;
  return pumpPct > 500;
}
