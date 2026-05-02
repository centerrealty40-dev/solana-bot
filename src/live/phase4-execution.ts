/**
 * W8.0 Phase 4 — Oscar parity: gates stay in papertrader; execution → Jupiter + simulate + live JSONL.
 */
import type { Keypair } from '@solana/web3.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { liveBuyQuoteAndPrepareSnapshot, liveSellQuoteAndPrepareSnapshot } from './jupiter.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { liveSimulateSignedTransaction, signLiveJupiterSwapBase64 } from './simulate.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { newLiveIntentId } from './intent.js';
import type { LiveOscarConfig } from './config.js';
import type {
  LiveOscarPhase4Discovery,
  LiveOscarPhase4Tracker,
  LiveOscarRuntimeBundle,
  LivePhase4BuyOpenContext,
} from './phase4-types.js';

let cachedSigner: Keypair | null = null;

function signer(liveCfg: LiveOscarConfig): Keypair {
  if (!cachedSigner) {
    const s = liveCfg.walletSecret?.trim();
    if (!s) throw new Error('LIVE_WALLET_SECRET missing for Phase 4 simulate');
    cachedSigner = loadLiveKeypairFromSecretEnv(s);
  }
  return cachedSigner;
}

export function tokenAmountRawFromUsd(
  usdNotional: number,
  priceUsdPerToken: number,
  decimals: number,
): string | null {
  if (!(usdNotional > 0) || !(priceUsdPerToken > 0)) return null;
  const dec = Math.min(24, Math.max(0, Math.floor(decimals)));
  const tokens = usdNotional / priceUsdPerToken;
  const factor = 10 ** dec;
  const raw = BigInt(Math.max(1, Math.floor(tokens * factor)));
  return raw.toString();
}

async function runSolToTokenPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    intentKind: 'buy_open' | 'dca_add';
  },
): Promise<boolean> {
  if (!liveCfg.strategyEnabled) return false;
  if (liveCfg.executionMode === 'dry_run') {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
    });
    return false;
  }
  if (liveCfg.executionMode !== 'simulate') return false;

  const solUsd = getSolUsd() ?? 0;
  const intentId = newLiveIntentId();
  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();

  const prep = await liveBuyQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    outputMint: args.mint,
    sizeUsd: args.usdNotional,
    solUsd,
    userPublicKey: pk,
  });

  const quoteSnapshot = prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true };

  appendLiveJsonlEvent({
    kind: 'execution_attempt',
    intentId,
    side: 'buy',
    mint: args.mint,
    intendedUsd: args.usdNotional,
    executionMode: liveCfg.executionMode,
    quoteSnapshot,
    targetPriceUsd: null,
  });

  if (!prep || !prep.swapBuild.ok) {
    const reason =
      prep == null ? 'no_quote' : prep.swapBuild.ok === false ? prep.swapBuild.reason : 'swap_build';
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      error: { message: reason },
    });
    return false;
  }

  const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);
  const sim = await liveSimulateSignedTransaction({
    cfg: liveCfg,
    signedTxSerializedBase64: signedB64,
  });

  if (!sim.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      unitsConsumed: sim.unitsConsumed ?? null,
      error: { message: sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : '') },
    });
    return false;
  }

  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'sim_ok',
    simulated: true,
    unitsConsumed: sim.unitsConsumed ?? null,
  });
  return true;
}

async function runTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
  },
): Promise<boolean> {
  if (!liveCfg.strategyEnabled) return false;
  if (liveCfg.executionMode === 'dry_run') {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
    });
    return false;
  }
  if (liveCfg.executionMode !== 'simulate') return false;

  const raw = tokenAmountRawFromUsd(args.usdNotional, args.priceUsdPerToken, args.decimals);
  if (raw == null) {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: 'token_amount_raw',
      detail: args.mint.slice(0, 8),
    });
    return false;
  }

  const solUsd = getSolUsd() ?? 0;
  const intentId = newLiveIntentId();
  const kp = signer(liveCfg);
  const pk = kp.publicKey.toBase58();

  const prep = await liveSellQuoteAndPrepareSnapshot({
    cfg: liveCfg,
    inputMint: args.mint,
    tokenAmountRaw: raw,
    solUsd,
    userPublicKey: pk,
  });

  const quoteSnapshot = prep?.quoteSnapshot ?? { provider: 'jupiter', empty: true };

  appendLiveJsonlEvent({
    kind: 'execution_attempt',
    intentId,
    side: 'sell',
    mint: args.mint,
    intendedUsd: args.usdNotional,
    intendedAmountAtomic: raw,
    executionMode: liveCfg.executionMode,
    quoteSnapshot,
    targetPriceUsd: args.priceUsdPerToken,
  });

  if (!prep || !prep.swapBuild.ok) {
    const reason =
      prep == null ? 'no_quote' : prep.swapBuild.ok === false ? prep.swapBuild.reason : 'swap_build';
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      error: { message: reason },
    });
    return false;
  }

  const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);
  const sim = await liveSimulateSignedTransaction({
    cfg: liveCfg,
    signedTxSerializedBase64: signedB64,
  });

  if (!sim.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      unitsConsumed: sim.unitsConsumed ?? null,
      error: { message: sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : '') },
    });
    return false;
  }

  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'sim_ok',
    simulated: true,
    unitsConsumed: sim.unitsConsumed ?? null,
  });
  return true;
}

function createDiscovery(liveCfg: LiveOscarConfig): LiveOscarPhase4Discovery {
  return {
    async tryExecuteBuyOpen(ctx: LivePhase4BuyOpenContext): Promise<boolean> {
      return runSolToTokenPipeline(liveCfg, {
        mint: ctx.ot.mint,
        symbol: ctx.ot.symbol,
        usdNotional: ctx.paperCfg.positionUsd,
        intentKind: 'buy_open',
      });
    },
  };
}

function createTracker(liveCfg: LiveOscarConfig): LiveOscarPhase4Tracker {
  return {
    trySolToTokenBuy(args) {
      return runSolToTokenPipeline(liveCfg, {
        mint: args.mint,
        symbol: args.symbol,
        usdNotional: args.usdNotional,
        intentKind: 'dca_add',
      });
    },
    tryTokenToSolSell(args) {
      return runTokenToSolPipeline(liveCfg, args);
    },
  };
}

export function createLiveOscarPhase4Bundle(liveCfg: LiveOscarConfig): LiveOscarRuntimeBundle {
  return {
    liveCfg,
    discovery: createDiscovery(liveCfg),
    tracker: createTracker(liveCfg),
  };
}
