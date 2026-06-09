import { PublicKey } from '@solana/web3.js';
import { canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk';
import { fetchMintPoolAddress } from './watchlist.js';
import { isTradablePumpPool, loadPumpSwapState } from './pumpswap-direct.js';

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
