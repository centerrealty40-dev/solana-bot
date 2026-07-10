/**
 * Canonical Solana HTTPS RPC URL chain for prod.
 *
 * Primary: Alchemy / SA_RPC (metered via qn-client + solana-rpc-meter).
 * Fallback: Helius only when `SOLANA_RPC_HELIUS_FALLBACK_ENABLED=1` and primary missing or QN budget block.
 */

export function heliusRpcUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.HELIUS_RPC_URL?.trim();
  if (url) return url;
  const key = env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return '';
}

/** Alchemy-first chain (QuickNode/Helius only if SA_RPC unset). */
export function primarySolanaRpcUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SA_RPC_HTTP_URL?.trim() ||
    env.ALCHEMY_HTTP_URL?.trim() ||
    env.SOLANA_RPC_HTTP_URL?.trim() ||
    env.QUICKNODE_HTTP_URL?.trim() ||
    ''
  );
}

export function resolveSolanaRpcUrl(opts?: {
  httpUrlOverride?: string;
  /** When true, return Helius URL only (for explicit fallback path). */
  useHeliusFallback?: boolean;
}): string {
  const override = opts?.httpUrlOverride?.trim();
  if (override) return override;
  if (opts?.useHeliusFallback) return heliusRpcUrlFromEnv();
  const primary = primarySolanaRpcUrlFromEnv();
  if (primary) return primary;
  if (heliusRpcFallbackEnabled()) return heliusRpcUrlFromEnv();
  return '';
}

export function heliusRpcFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOLANA_RPC_HELIUS_FALLBACK_ENABLED === '1';
}

export function isAlchemyRpcEndpoint(url: string): boolean {
  return /alchemy\.com/i.test(url);
}

/** Live Oscar / send+sim: billable RPC on Helius while QuickNode URL stays in .env for ingest. */
export function heliusRpcPreferEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOLANA_RPC_HELIUS_PREFER === '1';
}

export function isHeliusRpcEndpoint(url: string): boolean {
  return /helius-rpc\.com/i.test(url);
}

/** `LIVE_RPC_HTTP_URL` or Helius when `SOLANA_RPC_HELIUS_PREFER=1`. */
export function liveOscarRpcHttpUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.LIVE_RPC_HTTP_URL?.trim();
  if (explicit) return explicit;
  if (heliusRpcPreferEnabled(env)) {
    const h = heliusRpcUrlFromEnv(env);
    if (h) return h;
  }
  return undefined;
}

/** WebSocket RPC — explicit `SA_RPC_WS_URL` or flip http(s)→ws(s) on primary HTTP URL. */
export function resolveSolanaRpcWsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    env.SA_RPC_WS_URL?.trim() ||
    env.SOLANA_RPC_WS_URL?.trim() ||
    env.QUICKNODE_WS_URL?.trim() ||
    env.ALCHEMY_WS_URL?.trim();
  if (explicit) return explicit;
  const http =
    env.SA_RPC_HTTP_URL?.trim() ||
    env.ALCHEMY_HTTP_URL?.trim() ||
    env.SOLANA_RPC_HTTP_URL?.trim() ||
    env.QUICKNODE_HTTP_URL?.trim() ||
    primarySolanaRpcUrlFromEnv(env) ||
    heliusRpcUrlFromEnv(env);
  if (!http) return '';
  if (http.startsWith('https://')) return `wss://${http.slice('https://'.length)}`;
  if (http.startsWith('http://')) return `ws://${http.slice('http://'.length)}`;
  return '';
}
