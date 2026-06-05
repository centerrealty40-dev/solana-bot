import { fetchHypurrscanUserTwapFeed } from './hypurrscan.js';
import type { HypurrscanTwapRow } from './types.js';

export type UserTwapRating = {
  endedTotal: number;
  cancelCount: number;
  finishedCount: number;
  /** Share of ended TWAPs that were cancelled (0–100). */
  cancelPct: number | null;
};

const MIN_ENDED_FOR_PCT = 3;

/** HypurrScan `ended` / HL twap status → cancelled vs completed. */
export function isTwapEndedCancelled(ended: string): boolean {
  const s = ended.toLowerCase();
  if (s === 'finished' || s === 'activated') return false;
  if (s === 'error' || s === 'terminated' || s === 'cancelled' || s === 'canceled') return true;
  return s.includes('cancel') || s.includes('terminat') || s.includes('error');
}

export function isTwapEndedFinished(ended: string): boolean {
  return ended.toLowerCase() === 'finished';
}

/** Dedupe by hash; keep row with `ended` when present. */
export function dedupeTwapRowsByHash(rows: HypurrscanTwapRow[]): HypurrscanTwapRow[] {
  const byHash = new Map<string, HypurrscanTwapRow>();
  for (const row of rows) {
    const h = row.hash?.toLowerCase();
    if (!h) continue;
    const prev = byHash.get(h);
    if (!prev || (!prev.ended && row.ended)) byHash.set(h, row);
  }
  return [...byHash.values()];
}

export function computeUserTwapRating(rows: HypurrscanTwapRow[], user: string): UserTwapRating {
  const u = user.toLowerCase();
  const deduped = dedupeTwapRowsByHash(rows.filter((r) => (r.user || '').toLowerCase() === u));

  let cancelCount = 0;
  let finishedCount = 0;
  for (const row of deduped) {
    const ended = row.ended?.trim();
    if (!ended) continue;
    if (isTwapEndedCancelled(ended)) cancelCount++;
    else if (isTwapEndedFinished(ended)) finishedCount++;
    else cancelCount++;
  }

  const endedTotal = cancelCount + finishedCount;
  const cancelPct =
    endedTotal >= MIN_ENDED_FOR_PCT ? (cancelCount / endedTotal) * 100 : null;

  return { endedTotal, cancelCount, finishedCount, cancelPct };
}

export async function resolveUserTwapRating(
  user: string,
  feedRows: HypurrscanTwapRow[],
): Promise<UserTwapRating> {
  const fromFeed = computeUserTwapRating(feedRows, user);
  if (fromFeed.endedTotal >= MIN_ENDED_FOR_PCT) return fromFeed;

  try {
    const userRows = await fetchHypurrscanUserTwapFeed(user);
    const merged = dedupeTwapRowsByHash([...feedRows, ...userRows]);
    return computeUserTwapRating(merged, user);
  } catch {
    return fromFeed;
  }
}

export function formatUserRatingLineRu(r: UserTwapRating): string {
  if (r.endedTotal === 0) return 'Рейтинг: нет завершённых TWAP в индексе';
  if (r.cancelPct == null) {
    return `Рейтинг: мало данных (${r.endedTotal} TWAP, отмен ${r.cancelCount})`;
  }
  const tier = r.cancelPct >= 50 ? '🔴' : r.cancelPct >= 25 ? '🟡' : '🟢';
  return `Рейтинг: ${tier} отмена ${r.cancelPct.toFixed(0)}% (${r.cancelCount}/${r.endedTotal} TWAP)`;
}
