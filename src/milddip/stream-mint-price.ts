/**
 * Balance-route USD price for a mint from one parsed tx.
 * Does not need slot/blockTime — unlike allowlisted SwapInsert decode —
 * so stream price sampling still works when RPC omits those fields.
 */
import { signerPubkeys } from '../parser/pumpfun.js';
import type { TokenBal, TxJsonParsed } from '../parser/rpc-http.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

function rawFor(balances: TokenBal[] | null | undefined, owner: string, mint: string): bigint {
  if (!balances) return 0n;
  let total = 0n;
  for (const b of balances) {
    if (!b?.owner || b.owner !== owner || b.mint !== mint) continue;
    const raw = b.uiTokenAmount?.amount;
    if (raw == null) continue;
    try {
      total += BigInt(String(raw));
    } catch {
      /* skip */
    }
  }
  return total;
}

function rawDeltaFor(
  post: TokenBal[] | null | undefined,
  pre: TokenBal[] | null | undefined,
  owner: string,
  mint: string,
): bigint {
  return rawFor(post, owner, mint) - rawFor(pre, owner, mint);
}

function poolOwnerForMintDelta(
  pre: TokenBal[],
  post: TokenBal[],
  mint: string,
  baseDelta: bigint,
  wallet: string,
): string | null {
  const byIndex = new Map<
    number,
    { pre: bigint; post: bigint; preOwner?: string; postOwner?: string }
  >();
  for (const [balances, side] of [
    [pre, 'pre'],
    [post, 'post'],
  ] as const) {
    for (const balance of balances) {
      if (
        balance?.mint !== mint ||
        typeof balance.accountIndex !== 'number' ||
        !Number.isInteger(balance.accountIndex) ||
        balance.accountIndex < 0
      ) {
        continue;
      }
      const current = byIndex.get(balance.accountIndex) ?? { pre: 0n, post: 0n };
      const raw = balance.uiTokenAmount?.amount;
      if (raw != null) {
        try {
          current[side] += BigInt(String(raw));
        } catch {
          /* skip */
        }
      }
      if (typeof balance.owner === 'string' && balance.owner) {
        current[`${side}Owner`] = balance.owner;
      }
      byIndex.set(balance.accountIndex, current);
    }
  }
  let bestOwner: string | null = null;
  let bestAbs = 0n;
  for (const entry of byIndex.values()) {
    const delta = entry.post - entry.pre;
    const owner = entry.postOwner ?? entry.preOwner;
    if (!owner || owner === wallet || delta === 0n) continue;
    if ((delta > 0n) === (baseDelta > 0n)) continue;
    const abs = delta < 0n ? -delta : delta;
    if (abs > bestAbs) {
      bestAbs = abs;
      bestOwner = owner;
    }
  }
  return bestOwner;
}

function decimalsFor(balances: TokenBal[] | null | undefined, mint: string): number {
  if (!balances) return 6;
  for (const b of balances) {
    if (b?.mint === mint && typeof b.uiTokenAmount?.decimals === 'number') {
      return b.uiTokenAmount.decimals;
    }
  }
  return mint === WSOL ? 9 : 6;
}

export function mintDecimalsFromTxMeta(
  tx: TxJsonParsed | null | undefined,
  mint: string,
): number | null {
  if (!tx || !mint) return null;
  const post = tx.meta?.postTokenBalances ?? [];
  const pre = tx.meta?.preTokenBalances ?? [];
  for (const balances of [post, pre]) {
    for (const b of balances) {
      if (b?.mint === mint && typeof b.uiTokenAmount?.decimals === 'number') {
        const decimals = b.uiTokenAmount.decimals;
        if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 24) {
          return decimals;
        }
      }
    }
  }
  return null;
}

function walletLamportsDelta(tx: TxJsonParsed, wallet: string): bigint | null {
  const keysRaw = tx.transaction?.message?.accountKeys;
  const keys: unknown[] = Array.isArray(keysRaw) ? keysRaw : [];
  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const pk =
      typeof k === 'string' ? k : k && typeof k === 'object' && 'pubkey' in k
        ? String((k as { pubkey?: string }).pubkey ?? '')
        : '';
    if (pk === wallet) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const pre = tx.meta?.preBalances?.[idx];
  const post = tx.meta?.postBalances?.[idx];
  if (typeof pre !== 'number' || typeof post !== 'number') return null;
  return BigInt(post) - BigInt(pre);
}

/**
 * USD per whole token for `mint` from signer balance deltas in `tx`.
 * Returns null when the tx does not clearly trade mint vs SOL/USDC/USDT.
 */
export function mintPriceUsdFromTxMeta(
  tx: TxJsonParsed | null | undefined,
  mint: string,
  solUsd: number,
  opts?: { minSignerNotionalUsd?: number },
): number | null {
  if (!tx || !mint || mint.length < 32 || !(solUsd > 0)) return null;
  if (tx.meta?.err != null) return null;
  const preB = tx.meta?.preTokenBalances ?? [];
  const postB = tx.meta?.postTokenBalances ?? [];
  const dec = decimalsFor(postB, mint) || decimalsFor(preB, mint) || 6;
  const scale = 10 ** dec;

  for (const wallet of signerPubkeys(tx)) {
    const baseDelta = rawFor(postB, wallet, mint) - rawFor(preB, wallet, mint);
    if (baseDelta === 0n) continue;
    const baseHuman = Number(baseDelta >= 0n ? baseDelta : -baseDelta) / scale;
    if (!(baseHuman > 0)) continue;

    const poolOwner = poolOwnerForMintDelta(preB, postB, mint, baseDelta, wallet);
    if (poolOwner) {
      const poolWsolDelta = rawDeltaFor(postB, preB, poolOwner, WSOL);
      const poolUsdcDelta = rawDeltaFor(postB, preB, poolOwner, USDC);
      const poolUsdtDelta = rawDeltaFor(postB, preB, poolOwner, USDT);
      const poolLamports = walletLamportsDelta(tx, poolOwner);
      const poolQuotes = [
        (Number(poolWsolDelta < 0n ? -poolWsolDelta : poolWsolDelta) / 1e9) * solUsd,
        Number(poolUsdcDelta < 0n ? -poolUsdcDelta : poolUsdcDelta) / 1e6,
        Number(poolUsdtDelta < 0n ? -poolUsdtDelta : poolUsdtDelta) / 1e6,
        poolLamports != null
          ? (Number(poolLamports < 0n ? -poolLamports : poolLamports) / 1e9) * solUsd
          : 0,
      ];
      const poolQuoteUsd = poolQuotes.find((quote) => quote > 0) ?? 0;
      if (poolQuoteUsd > 0) {
        const px = poolQuoteUsd / baseHuman;
        if (px > 0 && Number.isFinite(px)) return px;
      }
    }

    const wsolDelta = rawFor(postB, wallet, WSOL) - rawFor(preB, wallet, WSOL);
    const usdcDelta = rawFor(postB, wallet, USDC) - rawFor(preB, wallet, USDC);
    const usdtDelta = rawFor(postB, wallet, USDT) - rawFor(preB, wallet, USDT);
    const lam = walletLamportsDelta(tx, wallet);
    const fee = typeof tx.meta?.fee === 'number' ? BigInt(tx.meta.fee) : 0n;

    let quoteUsd = 0;
    if (baseDelta > 0n) {
      // buy: spent quote
      let spentLamports = 0n;
      if (lam != null && lam < 0n) {
        const spent = -lam - fee;
        if (spent > 0n) spentLamports = spent;
      }
      const spentWsol = wsolDelta < 0n ? -wsolDelta : 0n;
      const spentUsdc = usdcDelta < 0n ? -usdcDelta : 0n;
      const spentUsdt = usdtDelta < 0n ? -usdtDelta : 0n;
      quoteUsd =
        (Number(spentLamports + spentWsol) / 1e9) * solUsd +
        Number(spentUsdc) / 1e6 +
        Number(spentUsdt) / 1e6;
    } else {
      // sell: received quote
      const recvLamports = lam != null && lam > 0n ? lam : 0n;
      const recvWsol = wsolDelta > 0n ? wsolDelta : 0n;
      const recvUsdc = usdcDelta > 0n ? usdcDelta : 0n;
      const recvUsdt = usdtDelta > 0n ? usdtDelta : 0n;
      quoteUsd =
        (Number(recvLamports + recvWsol) / 1e9) * solUsd +
        Number(recvUsdc) / 1e6 +
        Number(recvUsdt) / 1e6;
    }
    const minSignerNotionalUsd = opts?.minSignerNotionalUsd ?? 5;
    if (!(quoteUsd >= minSignerNotionalUsd) || !(quoteUsd > 0)) continue;
    const px = quoteUsd / baseHuman;
    if (px > 0 && Number.isFinite(px)) return px;
  }
  return null;
}
