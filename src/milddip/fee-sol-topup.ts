/**
 * Periodic native-SOL fee top-up for mild-dip.
 *
 * Every `feeSolTopupIntervalMs` (default 30m): if native SOL wallet value is
 * below `feeSolTopupMinUsd` (default $5), swap `feeSolTopupBuyUsd` (default $20)
 * USDC → native SOL via Jupiter (`wrapAndUnwrapSol: true`).
 *
 * Dedicated path — do not use `executeCopyBuy(WSOL)` (denied mint / position noise).
 */
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import {
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
} from '../live/jupiter.js';
import { signLiveJupiterSwapBase64 } from '../live/simulate.js';
import { liveSendSignedSwapPipeline } from '../live/phase6-send.js';
import { getSolUsd, refreshSolPrice } from '../papertrader/pricing.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import { copyTraderLiveOscarBridge } from '../copytrader/live-bridge.js';
import { checkCopyFundingGate, resetCopyFundingCache } from '../copytrader/funding-gate.js';
import { USDC_MINT } from '../copytrader/quote-mint.js';
import type { MildDipConfig } from './config.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { appendMildDipJournal } from './state.js';

export type FeeSolTopupDecision =
  | { action: 'skip'; reason: 'disabled' | 'in_flight' | 'interval' | 'ok' | 'no_price' | 'insufficient_usdc' | 'not_live' }
  | { action: 'topup'; solBal: number; solValueUsd: number; usdcBal: number; buyUsd: number };

let lastCheckAtMs = 0;
let inFlight = false;
/** Min gap between urgent (below-reserve) top-up attempts — avoid Jupiter hammer. */
const URGENT_TOPUP_GAP_MS = 60_000;

export function resetFeeSolTopupForTests(): void {
  lastCheckAtMs = 0;
  inFlight = false;
}

/** Pure gate used by tests + `maybeTopUpFeeSol`. */
export function decideFeeSolTopup(args: {
  enabled: boolean;
  inFlight: boolean;
  nowMs: number;
  lastCheckAtMs: number;
  intervalMs: number;
  executionMode: string;
  solUsd: number;
  solBal: number;
  usdcBal: number;
  minUsd: number;
  buyUsd: number;
  /** When true, skip the healthy-path interval (SOL already below floor/reserve). */
  urgent?: boolean;
}): FeeSolTopupDecision {
  if (!args.enabled) return { action: 'skip', reason: 'disabled' };
  if (args.inFlight) return { action: 'skip', reason: 'in_flight' };
  if (
    !args.urgent &&
    args.lastCheckAtMs > 0 &&
    args.nowMs - args.lastCheckAtMs < args.intervalMs
  ) {
    return { action: 'skip', reason: 'interval' };
  }
  if (!(args.solUsd > 0)) return { action: 'skip', reason: 'no_price' };
  if (args.executionMode !== 'live' && args.executionMode !== 'dry_run' && args.executionMode !== 'paper') {
    return { action: 'skip', reason: 'not_live' };
  }
  const solValueUsd = args.solBal * args.solUsd;
  if (solValueUsd >= args.minUsd) return { action: 'skip', reason: 'ok' };
  if (args.usdcBal + 1e-9 < args.buyUsd) {
    return { action: 'skip', reason: 'insufficient_usdc' };
  }
  return {
    action: 'topup',
    solBal: args.solBal,
    solValueUsd,
    usdcBal: args.usdcBal,
    buyUsd: args.buyUsd,
  };
}

/**
 * Non-blocking fee-SOL top-up.
 * Healthy path: at most one check per `feeSolTopupIntervalMs` (default 30m).
 * Urgent path: if native SOL < minFeeSolReserve or value < minUsd, bypass the
 * interval (60s gap) — otherwise a start-time "ok" can still brick buys while
 * fee SOL drains between checks.
 */
export async function maybeTopUpFeeSol(
  cfg: MildDipConfig,
  nowMs = Date.now(),
  opts?: { forceUrgent?: boolean },
): Promise<boolean> {
  if (!cfg.feeSolTopupEnabled) return false;
  if (inFlight) return false;

  inFlight = true;
  try {
    await refreshSolPrice().catch(() => false);
    const solUsd = getSolUsd();
    const copyCfg = mildDipToCopyTraderConfig(cfg);

    // Reuse funding-gate RPC (USDC + native SOL) — cheap, cached 5s.
    // Tiny required USD: we only need the balance fields (ok may be false when
    // fee SOL is already below minFeeSolReserve — that is exactly when we top up).
    const bal = await checkCopyFundingGate(copyCfg, 0.01, nowMs);
    if (!bal.ok && bal.reason === 'wallet_balance_rpc') {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_fee_sol_topup',
        ok: false,
        reason: 'wallet_balance_rpc',
      });
      console.warn('[mild-dip] fee-sol topup: wallet balance RPC failed');
      return false;
    }
    const solBal = bal.feeSol;
    const usdcBal = bal.quoteUsd;
    const solValueUsd = solBal * (solUsd || 0);
    const urgent =
      Boolean(opts?.forceUrgent) ||
      solBal + 1e-12 < cfg.minFeeSolReserve ||
      solValueUsd + 1e-9 < cfg.feeSolTopupMinUsd;

    if (urgent) {
      if (lastCheckAtMs > 0 && nowMs - lastCheckAtMs < URGENT_TOPUP_GAP_MS) {
        return false;
      }
    } else if (lastCheckAtMs > 0 && nowMs - lastCheckAtMs < cfg.feeSolTopupIntervalMs) {
      return false;
    }

    lastCheckAtMs = nowMs;

    const decision = decideFeeSolTopup({
      enabled: cfg.feeSolTopupEnabled,
      inFlight: false,
      nowMs,
      lastCheckAtMs: 0, // interval already gated above
      intervalMs: cfg.feeSolTopupIntervalMs,
      executionMode: cfg.executionMode,
      solUsd,
      solBal,
      usdcBal,
      minUsd: cfg.feeSolTopupMinUsd,
      buyUsd: cfg.feeSolTopupBuyUsd,
      urgent,
    });

    if (decision.action === 'skip') {
      if (decision.reason === 'ok') {
        console.log(
          `[mild-dip] fee-sol ok sol=${solBal.toFixed(6)} ($${ (solBal * (solUsd || 0)).toFixed(2) }) ` +
            `min=$${cfg.feeSolTopupMinUsd}`,
        );
      } else if (decision.reason === 'insufficient_usdc' || decision.reason === 'no_price') {
        console.warn(`[mild-dip] fee-sol topup skipped: ${decision.reason}`, {
          solBal,
          usdcBal,
          needUsd: cfg.feeSolTopupBuyUsd,
          solUsd,
        });
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_fee_sol_topup',
          ok: false,
          reason: decision.reason,
          solBal,
          usdcBal,
          needUsd: cfg.feeSolTopupBuyUsd,
          solUsd,
        });
      }
      return false;
    }

    const buyUsd = decision.buyUsd;
    if (cfg.executionMode === 'paper' || cfg.executionMode === 'dry_run') {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_fee_sol_topup',
        ok: true,
        simulated: true,
        mode: cfg.executionMode,
        buyUsd,
        beforeSol: decision.solBal,
        beforeSolUsd: decision.solValueUsd,
        solUsd,
        usdcBal: decision.usdcBal,
      });
      console.log(
        `[mild-dip] fee-sol topup simulated buyUsd=$${buyUsd} beforeSol=${decision.solBal.toFixed(6)}`,
      );
      return true;
    }

    if (!cfg.walletSecret?.trim()) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_fee_sol_topup',
        ok: false,
        reason: 'no_wallet_secret',
      });
      return false;
    }

    const liveCfg = copyTraderLiveOscarBridge(copyCfg);
    const kp = loadLiveKeypairFromSecretEnv(cfg.walletSecret);
    const userPk = kp.publicKey.toBase58();
    const amountRaw = Math.max(1, Math.floor(buyUsd * 1e6));

    const quote = await liveFetchBuyQuote({
      cfg: liveCfg,
      outputMint: WRAPPED_SOL_MINT,
      sizeUsd: buyUsd,
      solUsd,
      slippageBpsOverride: cfg.slippageBps,
      inputMintOverride: USDC_MINT,
      inputAmountRawOverride: amountRaw,
    });
    if (!quote) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_fee_sol_topup',
        ok: false,
        reason: 'no_quote',
        buyUsd,
        beforeSol: decision.solBal,
        beforeSolUsd: decision.solValueUsd,
      });
      console.warn('[mild-dip] fee-sol topup: no Jupiter quote');
      return false;
    }

    const built = await liveBuildUnsignedSwapTx({
      cfg: liveCfg,
      quoteResponse: quote.quoteResponse,
      userPublicKey: userPk,
    });
    if (!built.ok) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_fee_sol_topup',
        ok: false,
        reason: built.reason,
        buyUsd,
        beforeSol: decision.solBal,
      });
      console.warn('[mild-dip] fee-sol topup: swap build failed', built.reason);
      return false;
    }

    const signed = signLiveJupiterSwapBase64(built.b64, kp);
    const outcome = await liveSendSignedSwapPipeline({
      cfg: liveCfg,
      signedTxSerializedBase64: signed,
    });

    const outRaw = quote.quoteResponse.outAmount;
    const outSol =
      typeof outRaw === 'string' && /^\d+$/.test(outRaw)
        ? Number(outRaw) / 1e9
        : typeof outRaw === 'number'
          ? outRaw / 1e9
          : null;

    if (!outcome.ok) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_fee_sol_topup',
        ok: false,
        reason: outcome.message ?? 'send_failed',
        buyUsd,
        beforeSol: decision.solBal,
        beforeSolUsd: decision.solValueUsd,
        outSolApprox: outSol,
      });
      console.warn('[mild-dip] fee-sol topup send failed', outcome.message);
      return false;
    }

    resetCopyFundingCache();
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_fee_sol_topup',
      ok: true,
      sig: outcome.signature ?? null,
      buyUsd,
      outSolApprox: outSol,
      beforeSol: decision.solBal,
      beforeSolUsd: decision.solValueUsd,
      solUsd,
      usdcBal: decision.usdcBal,
    });
    console.log(
      `[mild-dip] fee-sol topup ok sig=${outcome.signature ?? '?'} buyUsd=$${buyUsd} ` +
        `outSol≈${outSol != null ? outSol.toFixed(6) : '?'} ` +
        `before=${decision.solBal.toFixed(6)} ($${decision.solValueUsd.toFixed(2)})`,
    );
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_fee_sol_topup',
      ok: false,
      reason: 'error',
      error: msg.slice(0, 300),
    });
    console.error('[mild-dip] fee-sol topup error', msg.slice(0, 300));
    return false;
  } finally {
    inFlight = false;
  }
}
