import { fetchLiveWalletSplBalancesByMint } from '../live/reconcile-live.js';
import type { LiveOscarConfig } from '../live/config.js';
import type { PumpswapComboConfig } from './config.js';
import type { ComboExitMarkCache } from './exit-marks.js';
import { fetchExitMark } from './exit-marks.js';
import type { ComboPosition } from './types.js';
import { avgFillPrice } from './state.js';
import { fetchMintPoolAddress } from './watchlist.js';
import { quotePumpSwapExitPriceUsd } from './pumpswap-direct.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';

export async function quoteExitPriceUsdCached(
  cfg: PumpswapComboConfig,
  liveCfg: LiveOscarConfig,
  pos: ComboPosition,
  balances: Map<string, bigint> | null,
  cache: ComboExitMarkCache,
): Promise<{ priceUsd: number | null; tokenRaw: bigint }> {
  const mark = cache.get(pos.mint, cfg);
  if (mark) return { priceUsd: mark.priceUsd, tokenRaw: mark.tokenRaw };
  const fresh = await fetchExitMark(cfg, liveCfg, pos, balances);
  if (fresh) {
    cache.set(pos.mint, fresh);
    return { priceUsd: fresh.priceUsd, tokenRaw: fresh.tokenRaw };
  }
  return { priceUsd: null, tokenRaw: balances?.get(pos.mint) ?? 0n };
}

export async function quoteExitPriceUsdFresh(
  cfg: PumpswapComboConfig,
  liveCfg: LiveOscarConfig,
  pos: ComboPosition,
  balances: Map<string, bigint> | null,
  cache: ComboExitMarkCache,
): Promise<{ priceUsd: number | null; tokenRaw: bigint }> {
  const mark = await fetchExitMark(cfg, liveCfg, pos, balances);
  if (mark) {
    cache.set(pos.mint, mark);
    return { priceUsd: mark.priceUsd, tokenRaw: mark.tokenRaw };
  }
  return { priceUsd: null, tokenRaw: balances?.get(pos.mint) ?? 0n };
}

export function pnlPctVsAvgFill(pos: ComboPosition, markPriceUsd: number): number {
  const avg = avgFillPrice(pos);
  if (!(avg > 0) || !(markPriceUsd > 0)) return 0;
  return (markPriceUsd / avg - 1) * 100;
}

export function slPctForPosition(
  cfg: { slSingleLegPct: number; slMultiLegPct: number; slPreDcaPct: number; maxBuyLegs: number },
  pos: ComboPosition,
): number {
  if (pos.legs.length < cfg.maxBuyLegs) return cfg.slPreDcaPct;
  return pos.legs.length <= 1 ? cfg.slSingleLegPct : cfg.slMultiLegPct;
}

export async function quoteExitPriceUsd(
  liveCfg: LiveOscarConfig,
  mint: string,
  poolAddress?: string,
): Promise<{ priceUsd: number | null; tokenRaw: bigint }> {
  const secret = liveCfg.walletSecret?.trim();
  if (!secret) return { priceUsd: null, tokenRaw: 0n };
  const pk = loadLiveKeypairFromSecretEnv(secret).publicKey;
  const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
  const raw = chainMap?.get(mint) ?? 0n;
  if (raw <= 0n) return { priceUsd: null, tokenRaw: 0n };
  const pool = poolAddress?.trim() || (await fetchMintPoolAddress(mint));
  if (!pool) return { priceUsd: null, tokenRaw: raw };
  const rpcUrl = liveCfg.liveRpcHttpUrl?.trim();
  if (!rpcUrl) return { priceUsd: null, tokenRaw: raw };
  const q = await quotePumpSwapExitPriceUsd({ rpcUrl, poolAddress: pool, tokenRaw: raw, user: pk });
  return { priceUsd: q.priceUsd, tokenRaw: raw };
}
