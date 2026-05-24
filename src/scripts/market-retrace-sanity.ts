/**
 * Sanity-проверки pump/retrace паттернов: отсекаем битые бары PG, не реальные проливы.
 */

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
