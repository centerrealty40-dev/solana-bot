/**
 * Jupiter sell-probe for live tracker exit MTM (token → quote mint).
 * Buy-probes on thin PumpSwap routes can read ~20% below pool mid; sell-probe matches exit economics.
 */
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import { liveSellQuoteAndPrepareSnapshot } from './jupiter.js';
import {
  sellUsdPerTokenFromQuote,
  wsolOutLamportsFromJupiterSellQuote,
} from './open-position-exec-price.js';
import { tokenAmountRawFromUsd } from './phase4-execution.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';

function signerPk(liveCfg: LiveOscarConfig): string | null {
  const s = liveCfg.walletSecret?.trim();
  if (!s) return null;
  try {
    return loadLiveKeypairFromSecretEnv(s).publicKey.toBase58();
  } catch {
    return null;
  }
}

/** Executable sell USD/token at `probeUsd` notional for open-position MTM. */
export async function liveTrackerSellProbeUsdPerToken(args: {
  liveCfg: LiveOscarConfig;
  ot: OpenTrade;
  mint: string;
  probeUsd: number;
  solUsd: number;
  priceHintUsd: number;
  chainTokenRaw?: bigint;
}): Promise<number | null> {
  const { liveCfg, ot, mint, probeUsd, solUsd, priceHintUsd, chainTokenRaw } = args;
  if (!(probeUsd > 0) || !(priceHintUsd > 0) || !(solUsd > 0)) return null;
  const userPublicKey = signerPk(liveCfg);
  if (!userPublicKey) return null;
  const dec = ot.tokenDecimals ?? 6;
  let tokenRaw = tokenAmountRawFromUsd(probeUsd, priceHintUsd, dec);
  if (!tokenRaw) return null;
  if (chainTokenRaw != null && chainTokenRaw > 0n) {
    const computed = BigInt(tokenRaw);
    tokenRaw = (computed < chainTokenRaw ? computed : chainTokenRaw).toString();
  }
  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: mint,
    tokenAmountRaw: tokenRaw,
    solUsd,
    userPublicKey,
  });
  if (!prep?.quoteResponse) return null;
  const wsolLamports = wsolOutLamportsFromJupiterSellQuote(prep.quoteResponse);
  if (wsolLamports == null) return null;
  return sellUsdPerTokenFromQuote({
    wsolOutLamports: wsolLamports,
    tokenAmountRaw: BigInt(tokenRaw),
    solUsd,
    decimals: dec,
  });
}
