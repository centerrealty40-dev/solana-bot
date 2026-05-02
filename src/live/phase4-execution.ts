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
import { notifyLiveExecutionSimErr, notifyLiveExecutionSimOk } from './phase5-state.js';
import { liveSendSignedSwapPipeline, type LiveSendPipelineOutcome } from './phase6-send.js';

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

function finalizeLiveSendJsonl(intentId: string, outcome: LiveSendPipelineOutcome): boolean {
  if (outcome.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'confirmed',
      txSignature: outcome.signature,
      simulated: false,
      unitsConsumed: outcome.preSimUnits,
      slot: outcome.slot,
    });
    notifyLiveExecutionSimOk();
    return true;
  }
  if (outcome.kind === 'sim_err') {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      unitsConsumed: outcome.preSimUnits ?? null,
      error: { message: outcome.message },
    });
    notifyLiveExecutionSimErr();
    return false;
  }
  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'failed',
    simulated: false,
    txSignature: outcome.signature ?? null,
    unitsConsumed: outcome.preSimUnits ?? null,
    error: { message: outcome.message },
  });
  notifyLiveExecutionSimErr();
  return false;
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
  if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') return false;

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
    notifyLiveExecutionSimErr();
    return false;
  }

  const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

  if (liveCfg.executionMode === 'simulate') {
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
      notifyLiveExecutionSimErr();
      return false;
    }

    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_ok',
      simulated: true,
      unitsConsumed: sim.unitsConsumed ?? null,
    });
    notifyLiveExecutionSimOk();
    return true;
  }

  const liveOut = await liveSendSignedSwapPipeline({
    cfg: liveCfg,
    signedTxSerializedBase64: signedB64,
  });
  return finalizeLiveSendJsonl(intentId, liveOut);
}

export type LiveTokenToSolPipelineResult = {
  ok: boolean;
  wsolOutLamports?: bigint;
  txSignature?: string | null;
};

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
): Promise<LiveTokenToSolPipelineResult> {
  if (!liveCfg.strategyEnabled) return { ok: false };
  if (liveCfg.executionMode === 'dry_run') {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: `dry_run:${args.intentKind}`,
      detail: args.mint.slice(0, 8),
    });
    return { ok: false };
  }
  if (liveCfg.executionMode !== 'simulate' && liveCfg.executionMode !== 'live') return { ok: false };

  const raw = tokenAmountRawFromUsd(args.usdNotional, args.priceUsdPerToken, args.decimals);
  if (raw == null) {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: 'token_amount_raw',
      detail: args.mint.slice(0, 8),
    });
    return { ok: false };
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
    notifyLiveExecutionSimErr();
    return { ok: false };
  }

  const wsolOut = wsolOutLamportsFromSellQuote(prep.quoteResponse);

  const signedB64 = signLiveJupiterSwapBase64(prep.swapBuild.b64, kp);

  if (liveCfg.executionMode === 'simulate') {
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
      notifyLiveExecutionSimErr();
      return { ok: false };
    }

    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_ok',
      simulated: true,
      unitsConsumed: sim.unitsConsumed ?? null,
    });
    notifyLiveExecutionSimOk();
    return { ok: true, wsolOutLamports: wsolOut ?? undefined };
  }

  const liveOut = await liveSendSignedSwapPipeline({
    cfg: liveCfg,
    signedTxSerializedBase64: signedB64,
  });
  const ok = finalizeLiveSendJsonl(intentId, liveOut);
  return {
    ok,
    wsolOutLamports:
      liveCfg.executionMode === 'live' ? undefined : ok ? wsolOut ?? undefined : undefined,
    txSignature: liveOut.ok ? liveOut.signature : liveOut.signature ?? undefined,
  };
}

function wsolOutLamportsFromSellQuote(q: Record<string, unknown>): bigint | null {
  const out = q.outAmount;
  if (typeof out === 'string' && /^\d+$/.test(out)) return BigInt(out);
  return null;
}

/** Phase 5 capital rotation — same JSONL + consec hooks as tracker sells. */
export async function executeLiveTokenToSolPipeline(
  liveCfg: LiveOscarConfig,
  args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
  },
): Promise<LiveTokenToSolPipelineResult> {
  return runTokenToSolPipeline(liveCfg, args);
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
      return runTokenToSolPipeline(liveCfg, args).then((r) => r.ok);
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
