import { PublicKey } from '@solana/web3.js';
import { canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk';
import { fetchMintPoolAddress } from './watchlist.js';
import { isTradablePumpPool, isUsdcQuotedPool, isWsolQuotedPool, loadPumpSwapState } from './pumpswap-direct.js';

/** Read-only PumpSwap state probe user (no signing). */
const POOL_PROBE_USER = new PublicKey('11111111111111111111111111111111');

export async function verifyTradablePumpPool(rpcUrl: string, poolAddress: string): Promise<boolean> {
  try {
    const state = await loadPumpSwapState({
      rpcUrl,
      poolAddress,
      user: POOL_PROBE_USER,
    });
    return isTradablePumpPool(state);
  } catch {
    return false;
  }
}

export async function verifyWsolPumpPool(rpcUrl: string, poolAddress: string): Promise<boolean> {
  try {
    const state = await loadPumpSwapState({
      rpcUrl,
      poolAddress,
      user: POOL_PROBE_USER,
    });
    return isWsolQuotedPool(state);
  } catch {
    return false;
  }
}

export type ResolveMintWsolPoolResult = {
  pool: string | null;
  /** Leader / hint pointed at a USDC-quoted pool — we resolved WSOL elsewhere. */
  skippedUsdcHint?: string;
};

/** WSOL-quoted PumpSwap pool only — skips USDC pool hints, falls back to PG / canonical PDA. */
export async function resolveMintWsolPumpPool(
  rpcUrl: string,
  mint: string,
  poolHint?: string,
): Promise<ResolveMintWsolPoolResult> {
  const m = mint.trim();
  if (!m) return { pool: null };

  let skippedUsdcHint: string | undefined;
  const candidates: string[] = [];

  const hint = poolHint?.trim();
  if (hint) {
    if (await verifyWsolPumpPool(rpcUrl, hint)) {
      candidates.push(hint);
    } else {
      try {
        const state = await loadPumpSwapState({
          rpcUrl,
          poolAddress: hint,
          user: POOL_PROBE_USER,
        });
        if (isUsdcQuotedPool(state)) skippedUsdcHint = hint;
      } catch {
        /* invalid hint */
      }
    }
  }

  const pg = await fetchMintPoolAddress(m);
  if (pg) candidates.push(pg);

  try {
    candidates.push(canonicalPumpPoolPda(new PublicKey(m)).toBase58());
  } catch {
    /* invalid mint */
  }

  const seen = new Set<string>();
  for (const addr of candidates) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    if (await verifyWsolPumpPool(rpcUrl, addr)) {
      return { pool: addr, skippedUsdcHint };
    }
  }
  return { pool: null, skippedUsdcHint };
}

/** WSOL PumpSwap pool for mint — hint, PG snapshot, then canonical PDA. */
export async function resolveMintPumpPool(
  rpcUrl: string,
  mint: string,
  poolHint?: string,
): Promise<string | null> {
  const m = mint.trim();
  if (!m) return null;

  const candidates: string[] = [];
  if (poolHint?.trim()) candidates.push(poolHint.trim());

  const pg = await fetchMintPoolAddress(m);
  if (pg) candidates.push(pg);

  try {
    candidates.push(canonicalPumpPoolPda(new PublicKey(m)).toBase58());
  } catch {
    /* invalid mint */
  }

  const seen = new Set<string>();
  for (const addr of candidates) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    if (await verifyTradablePumpPool(rpcUrl, addr)) return addr;
  }
  return null;
}
