/**
 * Canonical Solana HTTPS RPC URL chain for prod.
 *
 * Primary: QuickNode / explicit SOLANA_RPC (metered via qn-client + solana-rpc-meter).
 * Fallback: Helius when primary missing or when qnCall retries after QN budget block.
 */

export function heliusRpcUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.HELIUS_RPC_URL?.trim();
  if (url) return url;
  const key = env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return '';
}

/** QuickNode-first chain (do not prefer Helius here). */
export function primarySolanaRpcUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SOLANA_RPC_HTTP_URL?.trim() ||
    env.QUICKNODE_HTTP_URL?.trim() ||
    env.SA_RPC_HTTP_URL?.trim() ||
    env.ALCHEMY_HTTP_URL?.trim() ||
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
  return primarySolanaRpcUrlFromEnv() || heliusRpcUrlFromEnv();
}

export function heliusRpcFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOLANA_RPC_HELIUS_FALLBACK_ENABLED !== '0';
}
