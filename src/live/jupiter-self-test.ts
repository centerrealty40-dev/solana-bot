/**
 * Optional Phase 2 smoke: one SOL→mint quote + unsigned swap build → `execution_attempt` JSONL.
 * Enable with LIVE_PHASE2_JUPITER_SELF_TEST=1 and LIVE_PHASE2_SELF_TEST_MINT=<spl mint>.
 */
import pino from 'pino';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { newLiveIntentId } from './intent.js';
import type { LiveOscarConfig } from './config.js';
import { liveBuyQuoteAndPrepareSnapshot, liveJupiterPlaceholderPubkey } from './jupiter.js';

const log = pino({ name: 'live-jupiter-self-test' });

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

export async function runLiveJupiterSelfTest(cfg: LiveOscarConfig): Promise<void> {
  if (!envBool(process.env.LIVE_PHASE2_JUPITER_SELF_TEST, false)) return;

  const mint = process.env.LIVE_PHASE2_SELF_TEST_MINT?.trim();
  if (!mint) {
    log.warn('LIVE_PHASE2_JUPITER_SELF_TEST=1 but LIVE_PHASE2_SELF_TEST_MINT missing — skip');
    return;
  }

  const sizeUsd = Number(process.env.LIVE_PHASE2_SELF_TEST_SIZE_USD ?? '1');
  const solUsd = Number(process.env.LIVE_PHASE2_SOL_USD ?? '150');
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(solUsd) || solUsd <= 0) {
    log.warn({ sizeUsd, solUsd }, 'invalid LIVE_PHASE2_* USD — skip');
    return;
  }

  const rawPk = process.env.LIVE_PHASE2_USER_PUBKEY?.trim();
  const userPk =
    rawPk && rawPk.length >= 40 ? rawPk : liveJupiterPlaceholderPubkey();

  const intentId = newLiveIntentId();
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
      detail: 'phase2_self_test: quote fetch failed',
    });
    log.warn({ mint }, 'Phase2 self-test quote failed');
    return;
  }

  appendLiveJsonlEvent({
    kind: 'execution_attempt',
    intentId,
    side: 'buy',
    mint,
    intendedUsd: sizeUsd,
    executionMode: cfg.executionMode,
    quoteSnapshot: prepared.quoteSnapshot,
  });

  log.info(
    {
      intentId,
      mint,
      swapBuildOk: prepared.swapBuild.ok,
      swapReason: prepared.swapBuild.ok ? undefined : prepared.swapBuild.reason,
    },
    'Phase2 Jupiter self-test done',
  );
}
