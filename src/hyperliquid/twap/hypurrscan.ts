import type { HypurrscanTwapRow } from './types.js';

const DEFAULT_TWAP_FEED = 'https://api.hypurrscan.io/twap/*';

export async function fetchHypurrscanTwapFeed(
  url = process.env.HL_TWAP_HYPURRSCAN_FEED_URL?.trim() || DEFAULT_TWAP_FEED,
  signal?: AbortSignal,
): Promise<HypurrscanTwapRow[]> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hypurrscan twap feed ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) throw new Error('hypurrscan twap feed: expected JSON array');
  return raw as HypurrscanTwapRow[];
}

export async function fetchHypurrscanUserTwapFeed(
  user: string,
  signal?: AbortSignal,
): Promise<HypurrscanTwapRow[]> {
  const addr = user.trim().toLowerCase();
  const base = process.env.HL_TWAP_HYPURRSCAN_BASE_URL?.trim() || 'https://api.hypurrscan.io';
  const url = `${base.replace(/\/$/, '')}/twap/${addr}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hypurrscan twap user ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) throw new Error('hypurrscan twap user: expected JSON array');
  return raw as HypurrscanTwapRow[];
}
