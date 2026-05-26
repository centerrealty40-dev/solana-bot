/**
 * W8.0 Phase 3 optional smoke: quote → build → sign → simulateTransaction → execution_attempt / execution_result.
 * LIVE_PHASE3_SIM_SELF_TEST=1, LIVE_PHASE3_SELF_TEST_MINT=..., ENABLED=1, LIVE_EXECUTION_MODE=simulate, LIVE_SIM_ENABLED=1.
 */
import pino from 'pino';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { newLiveIntentId } from './intent.js';
import type { LiveOscarConfig } from './config.js';
import { liveBuyQuoteAndPrepareSnapshot } from './jupiter.js';
import { loadLiveKeypairFromSecretEnv } from './wallet.js';
import { liveSimulateSignedTransaction, signLiveJupiterSwapBase64 } from './simulate.js';

const log = pino({ name: 'live-phase3-self-test' });

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

export async function runLivePhase3SimSelfTest(cfg: LiveOscarConfig): Promise<void> {
  if (!envBool(process.env.LIVE_PHASE3_SIM_SELF_TEST, false)) return;

  if (!cfg.strategyEnabled || cfg.executionMode !== 'simulate') {
    log.warn('LIVE_PHASE3_SIM_SELF_TEST=1 but strategy disabled or mode≠simulate — skip');
    return;
  }

  if (!cfg.liveSimEnabled) {
    log.warn('LIVE_PHASE3_SIM_SELF_TEST=1 but LIVE_SIM_ENABLED=0 — skip');
    return;
  }

  const mint = process.env.LIVE_PHASE3_SELF_TEST_MINT?.trim();
  if (!mint) {
    log.warn('LIVE_PHASE3_SIM_SELF_TEST=1 but LIVE_PHASE3_SELF_TEST_MINT missing — skip');
    return;
  }

  const rpc = process.env.SA_RPC_HTTP_URL?.trim();
  if (!rpc) {
    log.warn('LIVE_PHASE3_SIM_SELF_TEST=1 but SA_RPC_HTTP_URL missing — skip');
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: 'qn_http',
      detail: 'phase3_self_test: SA_RPC_HTTP_URL missing',
    });
    return;
  }

  const secret = cfg.walletSecret?.trim();
  if (!secret) {
    log.warn('phase3 self-test: no LIVE_WALLET_SECRET — skip');
    return;
  }

  let keypair;
  try {
    keypair = loadLiveKeypairFromSecretEnv(secret);
  } catch (e) {
    log.error({ err: (e as Error).message }, 'phase3 self-test keypair load failed');
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      reason: 'wallet_load_failed',
      detail: 'phase3_self_test: keypair',
    });
    return;
  }

  log.info({ walletPk: keypair.publicKey.toBase58() }, 'phase3 self-test wallet loaded');

  const sizeUsd = Number(process.env.LIVE_PHASE3_SELF_TEST_SIZE_USD ?? '1');
  const solUsd = Number(process.env.LIVE_PHASE3_SOL_USD ?? '150');
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(solUsd) || solUsd <= 0) {
    log.warn({ sizeUsd, solUsd }, 'invalid LIVE_PHASE3_* USD — skip');
    return;
  }

  const intentId = newLiveIntentId();
  const userPk = keypair.publicKey.toBase58();

  const prepared = await liveBuyQuoteAndPrepareSnapshot({
    cfg,
    outputMint: mint,
    sizeUsd,
    solUsd,
    userPublicKey: userPk,
  });

  if (!prepared) {
    appendLiveJsonlEvent({
      kind: 'execution_skip',
      intentId,
      reason: 'quote_stale',
      detail: 'phase3_self_test: quote fetch failed',
    });
    log.warn({ mint }, 'Phase3 self-test quote failed');
    return;
  }

  appendLiveJsonlEvent({
    kind: 'execution_attempt',
    intentId,
    side: 'buy',
    mint,
    intendedUsd: sizeUsd,
    executionMode: 'simulate',
    quoteSnapshot: prepared.quoteSnapshot,
  });

  if (!prepared.swapBuild.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      txSignature: null,
      unitsConsumed: null,
      error: { message: `swap_build:${prepared.swapBuild.reason}` },
    });
    log.warn({ intentId, reason: prepared.swapBuild.reason }, 'Phase3 swap build failed');
    return;
  }

  let signedB64: string;
  try {
    signedB64 = signLiveJupiterSwapBase64(prepared.swapBuild.b64, keypair);
  } catch (e) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      txSignature: null,
      unitsConsumed: null,
      error: { message: `sign:${(e as Error).message}` },
    });
    log.error({ err: (e as Error).message }, 'Phase3 sign failed');
    return;
  }

  const sim = await liveSimulateSignedTransaction({ cfg, signedTxSerializedBase64: signedB64 });

  if (!sim.ok) {
    appendLiveJsonlEvent({
      kind: 'execution_result',
      intentId,
      status: 'sim_err',
      simulated: true,
      txSignature: null,
      unitsConsumed: sim.unitsConsumed ?? null,
      error: { message: sim.kind + (sim.message ? `:${sim.message}` : '') },
    });
    log.warn({ intentId, sim }, 'Phase3 simulate failed');
    return;
  }

  appendLiveJsonlEvent({
    kind: 'execution_result',
    intentId,
    status: 'sim_ok',
    simulated: true,
    txSignature: null,
    unitsConsumed: sim.unitsConsumed,
  });

  log.info({ intentId, unitsConsumed: sim.unitsConsumed }, 'Phase3 simulate self-test ok');
}
