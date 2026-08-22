export function prioritizeFreshStructuralEntries<T>(
  entries: readonly T[],
  nowMs: number,
  entryGraceMs: number,
  limit: number,
  getStartedAtMs: (entry: T) => number,
): T[] {
  return [...entries]
    .sort((a, b) => {
      const aStartedAtMs = getStartedAtMs(a);
      const bStartedAtMs = getStartedAtMs(b);
      const aFresh = nowMs - aStartedAtMs <= entryGraceMs;
      const bFresh = nowMs - bStartedAtMs <= entryGraceMs;
      return Number(bFresh) - Number(aFresh) || aStartedAtMs - bStartedAtMs;
    })
    .slice(0, limit);
}
