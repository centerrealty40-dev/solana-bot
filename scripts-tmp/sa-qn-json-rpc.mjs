/**
 * W6.12 S03 — общий billable JSON-RPC через QuickNode с учётом `sa_qn_global_daily`.
 * Подключать из sigseed worker / wallet trace при появлении кода на этой ветке.
 */
import {
  qnCreditsPerRpc,
  qnGlobalLedgerEnabled,
  qnGlobalRefundCredits,
  qnGlobalReserveCredits,
} from './sa-qn-global-budget-lib.mjs';

/**
 * @param {import('pg').Pool} pool
 * @param {{ rpcUrl: string; componentId: string; method: string; params?: unknown; timeoutMs?: number; credits?: number }} opts
 * @returns {Promise<{ error?: unknown; result?: unknown }>}
 */
export async function jsonRpcWithQnLedger(pool, opts) {
  const { rpcUrl, componentId, method, params = [], timeoutMs = 15_000 } = opts;
  const credits = opts.credits ?? qnCreditsPerRpc();

  let ledgerReserved = false;
  if (qnGlobalLedgerEnabled()) {
    const res = await qnGlobalReserveCredits(pool, { componentId, credits });
    if (!res.ok) {
      return {
        error: {
          code: 'QN_GLOBAL_DAY_CAP',
          message: 'QuickNode global daily credits exhausted',
          creditsUsed: res.creditsUsed,
          creditsRemaining: res.creditsRemaining,
          dailyCap: res.dailyCap,
        },
      };
    }
    ledgerReserved = true;
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (j.error) {
      if (ledgerReserved) {
        await qnGlobalRefundCredits(pool, { componentId, credits }).catch(() => {});
        ledgerReserved = false;
      }
      return { error: j.error };
    }
    ledgerReserved = false;
    return { result: j.result };
  } catch (e) {
    if (ledgerReserved) {
      await qnGlobalRefundCredits(pool, { componentId, credits }).catch(() => {});
    }
    return { error: { message: String(e) } };
  } finally {
    clearTimeout(to);
  }
}
