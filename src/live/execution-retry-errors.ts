/**
 * 1.11.458 — shared retry classification for live buy/sell pipelines (Phase 1 execution hardening).
 */

/** Transient failures before simulate/send — retry inside the pipeline envelope. */
export function isRetryablePreBroadcastError(reason: string): boolean {
  if (!reason) return false;
  /** 429 — org-wide pause; tracker/copy retry on next tick, not tight sim loop. */
  if (reason === 'swap-http-429') return false;
  if (reason === 'no_quote' || reason === 'swap_build') return true;
  if (reason.startsWith('swap-http-')) return true;
  if (reason === 'swap-timeout' || reason === 'swap-fetch' || reason === 'swap-parse' || reason === 'no-swap-tx') {
    return true;
  }
  if (reason.startsWith('quote_stale')) return true;
  return false;
}

/** Pre-send simulate / RPC slippage failures that must surface as `sim_err`, not terminal `failed`. */
export function isPreSendSimFailureMessage(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (m.includes('0x1771') || m.includes('slippage')) return true;
  if (message.includes('Transaction simulation failed')) return true;
  if (message.startsWith('rpc_error:') || message.startsWith('qn_rpc_error:')) return true;
  return message.startsWith('sim_failed:') || message.includes('InstructionError');
}

export function isRetryableBuySimError(message: string): boolean {
  if (isInsufficientFundsBuyMessage(message)) return false;
  if (isRetryablePreBroadcastError(message)) return true;
  if (message.startsWith('send_failed')) return true;
  if (isPreSendSimFailureMessage(message)) return true;
  return message.startsWith('sim_failed:') || message.includes('InstructionError');
}

export function isRetryableSellSimError(message: string): boolean {
  if (!message) return false;
  if (message.startsWith('confirm_timeout')) return false;
  if (isRetryablePreBroadcastError(message)) return true;
  if (message.startsWith('send_failed')) return true;
  return message.startsWith('sim_failed:') || message.includes('InstructionError');
}

function isInsufficientFundsBuyMessage(message: string): boolean {
  return message.includes('insufficient_wallet_sol_for_buy') || message.includes('InsufficientFunds');
}
