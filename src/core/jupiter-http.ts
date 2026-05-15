export const JUPITER_QUOTE_URL_DEFAULT = 'https://api.jup.ag/swap/v1/quote';
export const JUPITER_SWAP_URL_DEFAULT = 'https://api.jup.ag/swap/v1/swap';
export const JUPITER_PRICE_V3_URL_DEFAULT = 'https://api.jup.ag/price/v3';

export function jupiterApiKey(): string | undefined {
  const key = process.env.JUPITER_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function jupiterJsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...extra,
  };
  const key = jupiterApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

function jupiterQuote429MaxRetries(): number {
  const s = process.env.JUPITER_QUOTE_429_MAX_RETRIES?.trim();
  if (s === '0') return 0;
  if (!s) return 3;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(8, n) : 3;
}

function jupiterQuote429InitialBackoffMs(): number {
  const s = process.env.JUPITER_QUOTE_429_INITIAL_BACKOFF_MS?.trim();
  if (!s) return 100;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(10_000, n) : 100;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * GET JSON for Jupiter `/swap/v1/quote` (and same-shape sell quotes).
 * Retries on **HTTP 429** with exponential backoff and optional `Retry-After` (seconds).
 * Tuned for Developer Platform Pro bursts; set `JUPITER_QUOTE_429_MAX_RETRIES=0` to disable.
 */
export async function fetchJupiterSwapQuoteGetJson(args: {
  url: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}): Promise<Record<string, unknown> | null> {
  const maxR = jupiterQuote429MaxRetries();
  let backoff = jupiterQuote429InitialBackoffMs();
  for (let j = 0; j <= maxR; j++) {
    const ac = new AbortController();
    const tt = setTimeout(() => ac.abort(), Math.max(500, args.timeoutMs));
    try {
      const resp = await fetch(args.url, {
        method: 'GET',
        signal: ac.signal,
        headers: jupiterJsonHeaders(args.extraHeaders ?? {}),
      });
      if (resp.status === 429 && j < maxR) {
        const ra = resp.headers.get('retry-after');
        let waitMs = backoff;
        if (ra) {
          const sec = Number.parseFloat(ra);
          if (Number.isFinite(sec) && sec >= 0) {
            waitMs = Math.max(waitMs, Math.min(15_000, Math.round(sec * 1000)));
          }
        }
        try {
          await resp.text();
        } catch {
          /* ignore body */
        }
        await sleepMs(waitMs);
        backoff = Math.min(8000, Math.floor(backoff * 1.8) || 200);
        continue;
      }
      if (!resp.ok) return null;
      const raw = (await resp.json()) as unknown;
      return typeof raw === 'object' && raw != null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(tt);
    }
  }
  return null;
}

export function jupiterPriceV3Url(id: string): string {
  const url = new URL(JUPITER_PRICE_V3_URL_DEFAULT);
  url.searchParams.set('ids', id);
  return url.toString();
}
