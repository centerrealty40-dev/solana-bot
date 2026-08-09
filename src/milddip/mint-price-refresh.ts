/**
 * Targeted on-chain price refresh for stream-impulse mints.
 * Not Dex enrich — only buyForce/hot mints with stale/missing ring samples.
 */
import {
  fetchParsedTransaction,
  fetchWalletSignatures,
} from '../copytrader/rpc.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { extractBuyEconomics } from './buy-economics.js';
import { mildDipPriceRing } from './price-ring.js';

export type MintPriceRefreshResult = {
  ok: boolean;
  mint: string;
  priceUsd: number | null;
  signature: string | null;
  reason?: string;
};

const lastRefreshAt = new Map<string, number>();
let grantTs: number[] = [];
let refreshedOk = 0;
let refreshedFail = 0;
let refreshedSkip = 0;

/** Env: MILD_DIP_MINT_PRICE_REFRESH=0 disables. */
export function mintPriceRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MILD_DIP_MINT_PRICE_REFRESH ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

export function mintPriceRefreshStats(): {
  ok: number;
  fail: number;
  skip: number;
} {
  return { ok: refreshedOk, fail: refreshedFail, skip: refreshedSkip };
}

function takeGlobalGrant(nowMs: number, maxPerMin: number): boolean {
  grantTs = grantTs.filter((t) => nowMs - t < 60_000);
  if (grantTs.length >= maxPerMin) return false;
  grantTs.push(nowMs);
  return true;
}

/**
 * Decode USD price for `mint` from a parsed swap tx (allowlisted DEX path).
 */
export function priceUsdFromParsedSwapTx(
  tx: TxJsonParsed | null | undefined,
  mint: string,
  solUsd: number,
): { priceUsd: number; signature: string } | null {
  if (!tx || !(solUsd > 0) || !mint) return null;
  const econ = extractBuyEconomics(tx, { solUsd });
  if (!econ || econ.mint !== mint || !(econ.priceUsd > 0)) return null;
  return { priceUsd: econ.priceUsd, signature: econ.signature };
}

/**
 * Fetch recent sigs for mint, decode first good swap → note into price ring.
 */
export async function refreshMintPriceFromChain(
  mint: string,
  rpcUrl: string,
  opts?: {
    nowMs?: number;
    minGapMs?: number;
    maxPerMin?: number;
    sigLimit?: number;
    /** When false, decode only — do not write ring (tests). */
    noteRing?: boolean;
  },
): Promise<MintPriceRefreshResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const minGap = Math.max(500, opts?.minGapMs ?? 2_000);
  const maxPerMin = Math.max(1, Math.min(120, opts?.maxPerMin ?? 20));
  const sigLimit = Math.max(1, Math.min(10, opts?.sigLimit ?? 4));
  const noteRing = opts?.noteRing !== false;

  if (!mint || mint.length < 32 || !rpcUrl?.trim()) {
    refreshedSkip += 1;
    return { ok: false, mint, priceUsd: null, signature: null, reason: 'bad_args' };
  }
  if (!mintPriceRefreshEnabled()) {
    refreshedSkip += 1;
    return { ok: false, mint, priceUsd: null, signature: null, reason: 'disabled' };
  }

  const last = lastRefreshAt.get(mint) ?? 0;
  if (nowMs - last < minGap) {
    refreshedSkip += 1;
    return { ok: false, mint, priceUsd: null, signature: null, reason: 'min_gap' };
  }
  if (!takeGlobalGrant(nowMs, maxPerMin)) {
    refreshedSkip += 1;
    return { ok: false, mint, priceUsd: null, signature: null, reason: 'budget' };
  }
  lastRefreshAt.set(mint, nowMs);

  const solUsd = getSolUsd();
  if (!(solUsd > 0)) {
    refreshedFail += 1;
    return { ok: false, mint, priceUsd: null, signature: null, reason: 'no_sol_usd' };
  }

  const { rows, rpcFailed } = await fetchWalletSignatures(rpcUrl, mint, sigLimit);
  if (rpcFailed) {
    refreshedFail += 1;
    return { ok: false, mint, priceUsd: null, signature: null, reason: 'sigs_rpc' };
  }
  for (const row of rows) {
    const tx = (await fetchParsedTransaction(rpcUrl, row.signature)) as TxJsonParsed | null;
    const hit = priceUsdFromParsedSwapTx(tx, mint, solUsd);
    if (!hit) continue;
    if (noteRing) {
      mildDipPriceRing.note(mint, hit.priceUsd, {
        tsMs: row.blockTime != null ? row.blockTime * 1000 : nowMs,
        source: 'stream',
      });
    }
    refreshedOk += 1;
    return {
      ok: true,
      mint,
      priceUsd: hit.priceUsd,
      signature: hit.signature,
    };
  }
  refreshedFail += 1;
  return { ok: false, mint, priceUsd: null, signature: null, reason: 'no_swap_price' };
}

/** Reset counters (tests). */
export function resetMintPriceRefreshStatsForTests(): void {
  refreshedOk = 0;
  refreshedFail = 0;
  refreshedSkip = 0;
  lastRefreshAt.clear();
  grantTs = [];
}
