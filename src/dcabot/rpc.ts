/**
 * dca_frontrun — minimal Solana JSON-RPC client with primary + fallback endpoint.
 * Read-only usage only (account info, token holders, balances, signatures).
 */
import { dcabotConfig } from './config.js';

let rpcId = 0;

async function call<T>(endpoint: string, method: string, params: unknown[], timeoutMs = 8000): Promise<T | null> {
  if (!endpoint) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: T; error?: unknown };
    if (json.error) return null;
    return (json.result ?? null) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function rpc<T>(method: string, params: unknown[], timeoutMs = 8000): Promise<T | null> {
  const primary = await call<T>(dcabotConfig.rpcUrl, method, params, timeoutMs);
  if (primary != null) return primary;
  if (dcabotConfig.rpcFallbackUrl) {
    return call<T>(dcabotConfig.rpcFallbackUrl, method, params, timeoutMs);
  }
  return null;
}
