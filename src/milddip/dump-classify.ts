/**
 * Classify a red-candle dump before soft trail giveback may fire.
 *
 * - whale_oneshot: one wallet dominates (emptied bag or ≥ share of tape)
 * - mass_flee: many distinct sellers in the window
 * - unknown: not enough stream sell prints yet
 */
import { signerPubkeys } from '../parser/pumpfun.js';
import type { TokenBal, TxJsonParsed } from '../parser/rpc-http.js';

export type DumpSellPrint = {
  mint: string;
  signature: string;
  seller: string;
  soldRaw: bigint;
  soldUsd: number;
  residualFrac: number;
  emptied: boolean;
  tsMs: number;
};

export type DumpClass = 'whale_oneshot' | 'mass_flee' | 'unknown';

export type DumpClassifyOpts = {
  /** Lookback for sell prints (ms). */
  windowMs: number;
  /** Min sold USD for a print to count. */
  minSellUsd: number;
  /** post/pre ≤ this ⇒ emptied bag. */
  maxPostResidualFrac: number;
  /** Min distinct sellers ⇒ mass_flee. */
  massMinSellers: number;
  /** One seller's share of tape USD ≥ this ⇒ whale (with minSellUsd). */
  whaleShare: number;
};

export type DumpClassifyResult = {
  class: DumpClass;
  sellers: number;
  prints: number;
  totalSoldUsd: number;
  topSeller: string | null;
  topSoldUsd: number;
  topEmptied: boolean;
  topShare: number;
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

/** Extract signer sells of `mint` from one parsed tx (any residual). */
export function extractMintSellPrints(
  tx: TxJsonParsed,
  mint: string,
  args: {
    priceUsd?: number;
    tsMs?: number;
    signature?: string;
    maxPostResidualFrac?: number;
  },
): DumpSellPrint[] {
  if (!mint || mint.length < 32) return [];
  if (tx.meta?.err != null) return [];
  const preB = tx.meta?.preTokenBalances ?? [];
  const postB = tx.meta?.postTokenBalances ?? [];
  const sig =
    args.signature ||
    (typeof tx.transaction?.signatures?.[0] === 'string'
      ? tx.transaction.signatures[0]
      : '');
  const tsMs = args.tsMs && args.tsMs > 0 ? args.tsMs : Date.now();
  const priceUsd = args.priceUsd != null && args.priceUsd > 0 ? args.priceUsd : 0;
  const maxResidual =
    args.maxPostResidualFrac != null &&
    args.maxPostResidualFrac >= 0 &&
    args.maxPostResidualFrac <= 1
      ? args.maxPostResidualFrac
      : 0.02;
  const dec = decimalsForMint(postB, mint) ?? decimalsForMint(preB, mint) ?? 6;
  const out: DumpSellPrint[] = [];
  for (const seller of signerPubkeys(tx)) {
    const pre = ownerMintRaw(preB, seller, mint);
    if (pre <= 0n) continue;
    const post = ownerMintRaw(postB, seller, mint);
    if (post >= pre) continue;
    const sold = pre - post;
    const residualFrac = Number(post) / Number(pre);
    const soldHuman = Number(sold) / 10 ** dec;
    const soldUsd = priceUsd > 0 && soldHuman > 0 ? soldHuman * priceUsd : 0;
    out.push({
      mint,
      signature: sig,
      seller,
      soldRaw: sold,
      soldUsd,
      residualFrac,
      emptied: residualFrac <= maxResidual + 1e-12,
      tsMs,
    });
  }
  return out;
}

export function classifyDumpFromPrints(
  prints: readonly DumpSellPrint[],
  nowMs: number,
  opts: DumpClassifyOpts,
): DumpClassifyResult {
  const windowMs = opts.windowMs > 0 ? opts.windowMs : 30_000;
  const minUsd = opts.minSellUsd > 0 ? opts.minSellUsd : 0;
  const massMin = opts.massMinSellers > 0 ? Math.floor(opts.massMinSellers) : 3;
  const whaleShare =
    opts.whaleShare > 0 && opts.whaleShare <= 1 ? opts.whaleShare : 0.6;
  const maxResidual =
    opts.maxPostResidualFrac >= 0 && opts.maxPostResidualFrac <= 1
      ? opts.maxPostResidualFrac
      : 0.02;

  const inWin = prints.filter((p) => nowMs - p.tsMs <= windowMs && p.tsMs <= nowMs + 1_000);
  // Prefer USD-qualified prints; if price missing, keep emptied large-raw as signal.
  const usable = inWin.filter((p) => {
    if (p.soldUsd >= minUsd) return true;
    if (minUsd <= 0) return p.soldRaw > 0n;
    // No price: still count emptied bags with meaningful raw (≥ 1 token @ 6dp).
    return p.emptied && p.soldRaw >= 1_000_000n;
  });

  if (usable.length === 0) {
    return {
      class: 'unknown',
      sellers: 0,
      prints: 0,
      totalSoldUsd: 0,
      topSeller: null,
      topSoldUsd: 0,
      topEmptied: false,
      topShare: 0,
    };
  }

  const bySeller = new Map<string, { usd: number; emptied: boolean; raw: bigint }>();
  for (const p of usable) {
    const prev = bySeller.get(p.seller) ?? { usd: 0, emptied: false, raw: 0n };
    prev.usd += p.soldUsd;
    prev.raw += p.soldRaw;
    if (p.emptied || p.residualFrac <= maxResidual + 1e-12) prev.emptied = true;
    bySeller.set(p.seller, prev);
  }
  const sellers = bySeller.size;
  let totalSoldUsd = 0;
  let topSeller: string | null = null;
  let topSoldUsd = 0;
  let topEmptied = false;
  let topRaw = 0n;
  for (const [seller, v] of bySeller) {
    totalSoldUsd += v.usd;
    const betterUsd = v.usd > topSoldUsd;
    const betterRaw = v.usd === topSoldUsd && v.raw > topRaw;
    if (betterUsd || betterRaw) {
      topSeller = seller;
      topSoldUsd = v.usd;
      topEmptied = v.emptied;
      topRaw = v.raw;
    }
  }
  const topShare = totalSoldUsd > 0 ? topSoldUsd / totalSoldUsd : topEmptied ? 1 : 0;

  // Whale: emptied bag with size, OR dominant share of the tape.
  const whaleEmptied =
    topEmptied && (topSoldUsd >= minUsd || (topSoldUsd === 0 && topRaw >= 1_000_000n));
  const whaleDominant =
    topSeller != null &&
    topSoldUsd >= minUsd &&
    topShare >= whaleShare &&
    sellers <= Math.max(2, massMin - 1);

  if (whaleEmptied || whaleDominant) {
    return {
      class: 'whale_oneshot',
      sellers,
      prints: usable.length,
      totalSoldUsd,
      topSeller,
      topSoldUsd,
      topEmptied,
      topShare,
    };
  }

  if (sellers >= massMin) {
    return {
      class: 'mass_flee',
      sellers,
      prints: usable.length,
      totalSoldUsd,
      topSeller,
      topSoldUsd,
      topEmptied,
      topShare,
    };
  }

  // Fewer than massMin sellers and no whale signature yet — wait for more tape.
  return {
    class: 'unknown',
    sellers,
    prints: usable.length,
    totalSoldUsd,
    topSeller,
    topSoldUsd,
    topEmptied,
    topShare,
  };
}

/** Per-mint ring of recent sell prints from stream decode. */
export type DumpSellTape = {
  note: (print: DumpSellPrint) => void;
  noteMany: (prints: readonly DumpSellPrint[]) => void;
  prints: (mint: string, nowMs: number, windowMs: number) => DumpSellPrint[];
  classify: (mint: string, nowMs: number, opts: DumpClassifyOpts) => DumpClassifyResult;
  clear: (mint: string) => void;
};

export function createDumpSellTape(maxPerMint = 64): DumpSellTape {
  const byMint = new Map<string, DumpSellPrint[]>();
  const seenSigSeller = new Set<string>();

  const push = (print: DumpSellPrint): void => {
    if (!print.mint || !print.seller || print.soldRaw <= 0n) return;
    const key = `${print.signature}:${print.seller}`;
    if (print.signature && seenSigSeller.has(key)) return;
    if (print.signature) {
      seenSigSeller.add(key);
      if (seenSigSeller.size > 8_000) {
        const drop = [...seenSigSeller].slice(0, 3_000);
        for (const s of drop) seenSigSeller.delete(s);
      }
    }
    const arr = byMint.get(print.mint) ?? [];
    arr.push(print);
    if (arr.length > maxPerMint) arr.splice(0, arr.length - maxPerMint);
    byMint.set(print.mint, arr);
  };

  return {
    note: push,
    noteMany(prints) {
      for (const p of prints) push(p);
    },
    prints(mint, nowMs, windowMs) {
      const arr = byMint.get(mint) ?? [];
      const w = windowMs > 0 ? windowMs : 30_000;
      return arr.filter((p) => nowMs - p.tsMs <= w);
    },
    classify(mint, nowMs, opts) {
      return classifyDumpFromPrints(byMint.get(mint) ?? [], nowMs, opts);
    },
    clear(mint) {
      byMint.delete(mint);
    },
  };
}

/**
 * Gate soft giveback until dump class is known (or wait times out → mass_flee).
 */
export type GivebackDumpGate = {
  /**
   * Call when trail giveback threshold is hit.
   * Returns whether soft giveback may fire now.
   */
  allowGiveback: (args: {
    mint: string;
    nowMs: number;
    classify: DumpClassifyResult;
    waitMs: number;
    onWhale: () => void;
  }) => {
    allow: boolean;
    pending: boolean;
    class: DumpClass;
    waitedMs: number;
  };
  clear: (mint: string) => void;
};

export function createGivebackDumpGate(): GivebackDumpGate {
  /** mint → first giveback-hit ts while awaiting classify */
  const pendingSince = new Map<string, number>();
  return {
    allowGiveback({ mint, nowMs, classify, waitMs, onWhale }) {
      const wait = waitMs > 0 ? waitMs : 5_000;
      if (classify.class === 'whale_oneshot') {
        pendingSince.delete(mint);
        onWhale();
        return { allow: false, pending: false, class: 'whale_oneshot', waitedMs: 0 };
      }
      if (classify.class === 'mass_flee') {
        pendingSince.delete(mint);
        return { allow: true, pending: false, class: 'mass_flee', waitedMs: 0 };
      }
      // unknown — start/continue wait
      const since = pendingSince.get(mint) ?? nowMs;
      if (!pendingSince.has(mint)) pendingSince.set(mint, nowMs);
      const waitedMs = Math.max(0, nowMs - since);
      if (waitedMs >= wait) {
        pendingSince.delete(mint);
        // Timeout: no whale evidence → treat as mass flee (do not freeze forever).
        return { allow: true, pending: false, class: 'unknown', waitedMs };
      }
      return { allow: false, pending: true, class: 'unknown', waitedMs };
    },
    clear(mint) {
      pendingSince.delete(mint);
    },
  };
}
