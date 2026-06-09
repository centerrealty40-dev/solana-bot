import { fetchParsedTransaction } from '../copytrader/rpc.js';
import { decodeAllowlistedDexSwapForWallet } from '../parser/allowlisted-dex-swap.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { Connection, PublicKey } from '@solana/web3.js';
import type { PumpswapComboConfig } from './config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const PUMPSWAP_DEX = 'pumpswap';

export type ShadowBuyMint = {
  mint: string;
  boughtAtMs: number;
  usdEst: number;
  fillPriceUsd: number;
  signature: string;
};

let cache: { at: number; mints: ShadowBuyMint[] } | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parsePumpSwapBuyMintLegacy(
  tx: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
  wallet: string,
  solUsd: number,
  minBuyUsd: number,
): Omit<ShadowBuyMint, 'signature' | 'fillPriceUsd'> & { fillPriceUsd: number } | null {
  const logs = tx.meta?.logMessages ?? [];
  if (!logs.some((l) => l.includes('Instruction: Buy'))) return null;

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const pm = new Map(pre.map((b) => [`${b.accountIndex}|${b.mint}`, b]));

  const msg = tx.transaction.message;
  const keys =
    'staticAccountKeys' in msg && Array.isArray(msg.staticAccountKeys)
      ? msg.staticAccountKeys
      : msg.getAccountKeys().staticAccountKeys;
  const wIdx = keys.findIndex((k) => k.toBase58() === wallet);

  let mint: string | null = null;
  let wsolOut = 0;
  for (const b of post) {
    if (b.owner !== wallet) continue;
    const p = pm.get(`${b.accountIndex}|${b.mint}`);
    const d = Number(b.uiTokenAmount?.uiAmount ?? 0) - Number(p?.uiTokenAmount?.uiAmount ?? 0);
    if (b.mint === WSOL && d < 0) wsolOut += -d;
    else if (b.mint !== WSOL && Math.abs(d) > 0) mint = b.mint;
  }
  if (!mint) return null;

  const fee = (tx.meta?.fee ?? 0) / 1e9;
  let solSpent = wsolOut;
  if (!(solSpent > 0) && wIdx >= 0 && tx.meta) {
    const delta = (tx.meta.postBalances[wIdx]! - tx.meta.preBalances[wIdx]!) / 1e9;
    if (delta < 0) solSpent = -delta - fee;
  }
  const usdEst = solSpent * solUsd;
  if (!(usdEst >= minBuyUsd)) return null;

  const blockTime = tx.blockTime ?? 0;
  return {
    mint,
    boughtAtMs: blockTime * 1000,
    usdEst,
    fillPriceUsd: 0,
  };
}

async function decodeShadowBuy(
  cfg: PumpswapComboConfig,
  wallet: string,
  signature: string,
  solUsd: number,
): Promise<ShadowBuyMint | null> {
  const raw = await fetchParsedTransaction(cfg.rpcUrl, signature);
  if (raw) {
    const swap = decodeAllowlistedDexSwapForWallet(raw as TxJsonParsed, wallet, solUsd);
    if (
      swap &&
      swap.side === 'buy' &&
      swap.dex === PUMPSWAP_DEX &&
      swap.amountUsd >= cfg.shadowMinBuyUsd &&
      swap.priceUsd > 0
    ) {
      const bt = swap.blockTime?.getTime?.() ?? Date.now();
      return {
        mint: swap.baseMint,
        boughtAtMs: bt,
        usdEst: swap.amountUsd,
        fillPriceUsd: swap.priceUsd,
        signature,
      };
    }
  }

  const conn = new Connection(cfg.rpcUrl, 'confirmed');
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err) return null;
  const legacy = parsePumpSwapBuyMintLegacy(tx, wallet, solUsd, cfg.shadowMinBuyUsd);
  if (!legacy) return null;
  return { ...legacy, signature };
}

/** Recent PumpSwap buy mints from shadow reference wallet (cached RPC poll). */
export async function fetchShadowBuyMints(
  cfg: PumpswapComboConfig,
  solUsd: number,
): Promise<ShadowBuyMint[]> {
  if (!cfg.shadowWalletEnabled || !cfg.shadowWalletPubkey) return [];

  const ttl = Math.max(15_000, cfg.shadowPollMs);
  const now = Date.now();
  if (cache && now - cache.at < ttl) return cache.mints;

  const conn = new Connection(cfg.rpcUrl, 'confirmed');
  const wallet = cfg.shadowWalletPubkey;
  const sinceSec = Math.floor((now - cfg.shadowLookbackMs) / 1000);
  const out: ShadowBuyMint[] = [];
  const seen = new Set<string>();

  let before: string | undefined;
  for (let page = 0; page < cfg.shadowSigPagesMax; page++) {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(wallet), {
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (!sigs.length) break;

    let stop = false;
    for (const row of sigs) {
      if (row.blockTime && row.blockTime < sinceSec) {
        stop = true;
        break;
      }
      if (row.err) continue;
      const parsed = await decodeShadowBuy(cfg, wallet, row.signature, solUsd);
      await sleep(120);
      if (!parsed || seen.has(parsed.mint)) continue;
      seen.add(parsed.mint);
      out.push(parsed);
    }
    if (stop) break;
    before = sigs.at(-1)?.signature;
    if (sigs.length < 100) break;
  }

  out.sort((a, b) => b.boughtAtMs - a.boughtAtMs);
  cache = { at: now, mints: out };
  return out;
}

export function shadowMintSet(mints: ShadowBuyMint[]): Set<string> {
  return new Set(mints.map((m) => m.mint));
}

/** Test helper */
export function resetShadowWalletCacheForTests(): void {
  cache = null;
}
