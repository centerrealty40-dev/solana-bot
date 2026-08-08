/**
 * One-shot emptied-bag dump detection + short exit grace.
 *
 * Leaders often ignore a single wallet that dumps its entire bag (post≈0) —
 * the print is temporary unless selling continues. We arm a short grace that
 * defers peak_giveback / peak_giveback_partial (cliff_dump still fires).
 */
import { signerPubkeys } from '../parser/pumpfun.js';
import type { TokenBal, TxJsonParsed } from '../parser/rpc-http.js';

export type OneshotDumpEvent = {
  mint: string;
  signature: string;
  seller: string;
  preRaw: bigint;
  postRaw: bigint;
  soldRaw: bigint;
  /** Estimated USD notional of the sold tokens (0 if unknown). */
  soldUsd: number;
  residualFrac: number;
  tsMs: number;
};

export type OneshotDumpDetectOpts = {
  /** Min sold USD to count as a dump (dust bags ignored). */
  minSellUsd: number;
  /** post/pre ≤ this ⇒ bag considered emptied (default 0.02). */
  maxPostResidualFrac: number;
};

function ownerMintRaw(
  balances: TokenBal[] | null | undefined,
  owner: string,
  mint: string,
): bigint {
  if (!balances) return 0n;
  let total = 0n;
  for (const b of balances) {
    if (!b?.owner || b.owner !== owner || b.mint !== mint) continue;
    const raw = b.uiTokenAmount?.amount;
    if (raw === undefined || raw === null) continue;
    try {
      total += BigInt(String(raw));
    } catch {
      /* skip */
    }
  }
  return total;
}

function decimalsForMint(
  balances: TokenBal[] | null | undefined,
  mint: string,
): number | null {
  if (!balances) return null;
  for (const b of balances) {
    if (b?.mint === mint && typeof b.uiTokenAmount?.decimals === 'number') {
      return b.uiTokenAmount.decimals;
    }
  }
  return null;
}

/**
 * Scan signers for a sell of `mint` that empties the wallet's bag.
 * Pure / offline — uses only tx meta balances + optional price hint.
 */
export function detectOneshotEmptiedDump(
  tx: TxJsonParsed,
  mint: string,
  opts: OneshotDumpDetectOpts,
  args?: { priceUsd?: number; tsMs?: number; signature?: string },
): OneshotDumpEvent | null {
  if (!mint || mint.length < 32) return null;
  if (tx.meta?.err != null) return null;
  const minSellUsd = opts.minSellUsd > 0 ? opts.minSellUsd : 0;
  const maxResidual =
    opts.maxPostResidualFrac >= 0 && opts.maxPostResidualFrac <= 1
      ? opts.maxPostResidualFrac
      : 0.02;
  const preB = tx.meta?.preTokenBalances ?? [];
  const postB = tx.meta?.postTokenBalances ?? [];
  const sig =
    args?.signature ||
    (typeof tx.transaction?.signatures?.[0] === 'string'
      ? tx.transaction.signatures[0]
      : '');
  const tsMs = args?.tsMs && args.tsMs > 0 ? args.tsMs : Date.now();
  const priceUsd = args?.priceUsd != null && args.priceUsd > 0 ? args.priceUsd : 0;
  const dec = decimalsForMint(postB, mint) ?? decimalsForMint(preB, mint) ?? 6;

  let best: OneshotDumpEvent | null = null;
  for (const seller of signerPubkeys(tx)) {
    const pre = ownerMintRaw(preB, seller, mint);
    if (pre <= 0n) continue;
    const post = ownerMintRaw(postB, seller, mint);
    if (post >= pre) continue; // not a sell
    const sold = pre - post;
    const residualFrac = Number(post) / Number(pre);
    if (!(residualFrac <= maxResidual + 1e-12)) continue;
    const soldHuman = Number(sold) / 10 ** dec;
    const soldUsd = priceUsd > 0 && soldHuman > 0 ? soldHuman * priceUsd : 0;
    if (minSellUsd > 0 && !(soldUsd >= minSellUsd)) continue;
    const ev: OneshotDumpEvent = {
      mint,
      signature: sig,
      seller,
      preRaw: pre,
      postRaw: post,
      soldRaw: sold,
      soldUsd,
      residualFrac,
      tsMs,
    };
    if (!best || ev.soldRaw > best.soldRaw) best = ev;
  }
  return best;
}

export type OneshotDumpGraceTracker = {
  note: (mint: string, nowMs: number, graceMs: number) => number;
  isActive: (mint: string, nowMs: number) => boolean;
  untilMs: (mint: string) => number;
  clear: (mint: string) => void;
  size: () => number;
};

/** In-memory mint → graceUntilMs. */
export function createOneshotDumpGraceTracker(): OneshotDumpGraceTracker {
  const until = new Map<string, number>();
  return {
    note(mint, nowMs, graceMs) {
      const g = graceMs > 0 ? graceMs : 0;
      const t = Math.max(until.get(mint) ?? 0, nowMs + g);
      until.set(mint, t);
      // Bound memory — drop expired.
      if (until.size > 200) {
        for (const [m, u] of until) {
          if (u <= nowMs) until.delete(m);
        }
      }
      return t;
    },
    isActive(mint, nowMs) {
      return (until.get(mint) ?? 0) > nowMs;
    },
    untilMs(mint) {
      return until.get(mint) ?? 0;
    },
    clear(mint) {
      until.delete(mint);
    },
    size: () => until.size,
  };
}
