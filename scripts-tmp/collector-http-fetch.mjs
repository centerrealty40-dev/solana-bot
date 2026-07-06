/**
 * Shared collector HTTP fetch with gate-aware timeout.
 * DexScreener slot wait can exceed 15s when 4 collectors share one gate;
 * the abort timer must start only after the slot is granted (HTTP phase).
 */
import { acquireDexScreenerSlot, isDexScreenerUrl } from './dexscreener-api-gate.mjs';

/**
 * @param {{ log: function, sleep: function, timeoutMs: number, maxRetries: number }} opts
 */
export function createCollectorFetchJsonWithRetry({ log, sleep, timeoutMs, maxRetries }) {
  return async function fetchJsonWithRetry(url, options = {}, retryTag = 'http', retryOpts = {}) {
    const retries = Number.isFinite(retryOpts.maxRetries) ? retryOpts.maxRetries : maxRetries;
    let attempt = 0;
    while (attempt <= retries) {
      const startedAt = Date.now();
      try {
        if (isDexScreenerUrl(url)) await acquireDexScreenerSlot();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            ...options,
            headers: {
              accept: 'application/json',
              ...(options.headers ?? {}),
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (res.ok) {
            return await res.json();
          }

          const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
          if (!retryable || attempt === retries) {
            throw new Error(`${retryTag} non-retryable status=${res.status}`);
          }

          const retryAfterHeader = Number(res.headers.get('retry-after'));
          const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? retryAfterHeader * 1000
            : 0;
          const backoffMs = retryAfterMs || Math.min(10_000, 500 * 2 ** attempt);
          log('warn', 'request retry scheduled', {
            retryTag,
            url,
            status: res.status,
            attempt,
            backoffMs,
            elapsedMs: Date.now() - startedAt,
          });
          attempt += 1;
          await sleep(backoffMs);
        } catch (error) {
          clearTimeout(timeout);
          throw error;
        }
      } catch (error) {
        if (attempt === retries) throw error;
        const backoffMs = Math.min(10_000, 500 * 2 ** attempt);
        log('warn', 'request failed, retrying', {
          retryTag,
          url,
          attempt,
          backoffMs,
          error: String(error),
        });
        attempt += 1;
        await sleep(backoffMs);
      }
    }
    throw new Error(`${retryTag} failed after retries`);
  };
}
