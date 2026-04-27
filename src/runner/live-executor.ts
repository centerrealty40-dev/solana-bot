import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import type { ExitSignal, HypothesisPositionView, HypothesisSignal } from '../hypotheses/base.js';

const log = child('live-executor');

/**
 * Live executor stub.
 *
 * **Stage 5 work — intentionally not wired into the runner.** Implementing this requires:
 *   1. A signed Jupiter v6 swap call using the wallet keypair
 *   2. Compute-budget instruction tuning
 *   3. Jito tip + bundle submission for sandwich protection
 *   4. Confirmation polling with exponential backoff
 *   5. Telegram alert on every successful fill and on submission errors
 *   6. Hard checks: program-id whitelist (Jupiter Aggregator only), per-tx slippage cap
 *
 * Until a hypothesis passes the 100-paper-trade gate AND the user manually flips
 * EXECUTOR_MODE=live, this module throws to prevent accidental execution.
 */
export async function executeLiveEntry(
  _signal: HypothesisSignal,
  _midPriceUsd: number,
  _approvedSizeUsd: number,
): Promise<bigint | null> {
  if (config.executorMode !== 'live') {
    log.warn('live executor called outside live mode — refusing');
    return null;
  }
  if (!config.walletKeypairPath) {
    log.error('WALLET_KEYPAIR_PATH not set — refusing live entry');
    return null;
  }
  throw new Error(
    'live entry not implemented yet (Stage 5). Run in paper mode until at least one ' +
      'hypothesis passes 100+ paper trades with positive expectancy.',
  );
}

export async function executeLiveExit(
  _pos: HypothesisPositionView,
  _exit: ExitSignal,
  _midPriceUsd: number,
): Promise<void> {
  if (config.executorMode !== 'live') {
    log.warn('live executor called outside live mode — refusing');
    return;
  }
  throw new Error('live exit not implemented yet (Stage 5).');
}
