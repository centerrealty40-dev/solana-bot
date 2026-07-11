import { fetch } from 'undici';
import type { AwakeningCandidate } from './awakening-types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractBaseMint(pool: Record<string, unknown>): string | null {
  const rel = pool.relationships as { base_token?: { data?: { id?: string } } } | undefined;
  const id = rel?.base_token?.data?.id;
  if (!id || typeof id !== 'string') return null;
  const parts = id.split('_');
  return parts.length > 1 ? parts[parts.length - 1]! : id;
}

/** Gecko trending pools — secondary candidate ingress (GMGN-style velocity feed). */
export async function fetchGeckoTrendingMints(opts: {
  pages: number;
  fetchImpl?: typeof fetch;
}): Promise<AwakeningCandidate[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const pages = Math.max(1, Math.min(3, opts.pages));
  const out: AwakeningCandidate[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= pages; page += 1) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`;
    try {
      const res = await doFetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) break;
      const json = (await res.json()) as { data?: unknown[] };
      const pools = Array.isArray(json.data) ? json.data : [];
      for (const poolData of pools) {
        const pool = poolData as Record<string, unknown>;
        const mint = extractBaseMint(pool);
        if (!mint || seen.has(mint)) continue;
        const attrs = pool.attributes as { dex_name?: string; name?: string } | undefined;
        const blob = `${attrs?.dex_name ?? ''} ${attrs?.name ?? ''}`.toLowerCase();
        if (!blob.includes('pump')) continue;
        seen.add(mint);
        out.push({ mint, source: 'gecko_trending' });
      }
    } catch {
      break;
    }
    if (page < pages) await sleep(250);
  }

  return out;
}
