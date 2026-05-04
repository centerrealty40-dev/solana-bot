import type pg from 'pg';
import type { ScamFarmConfig } from './config.js';
import { creditsPerStandardSolanaRpc, recordSolanaRpcCredits } from '../../core/rpc/solana-rpc-meter.js';

const seen = new Set<string>();

export type RpcCounters = { calls: number };

function qnLedgerEnvOn(): boolean {
  const v = (process.env.SA_QN_GLOBAL_LEDGER_ENABLED ?? '1').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Optional post-pass: JSON-RPC `getAccountInfo` (cheap) for top wallets, with hard cap + de-dupe.
 * URL: SOLANA_RPC_HTTP_URL / QUICKNODE (see config). Does not log full URL.
 *
 * W6.13 P1: при `pgPool` + включённом глобальном ledger billable вызовы идут через `jsonRpcWithQnLedger`
 * (`scam_farm_rpc_probe`); иначе — прежний `fetch` + локальный meter.
 */
export async function maybeAlchemyProbes(
  c: ScamFarmConfig,
  wallets: string[],
  counters: RpcCounters,
  opts?: { pgPool: pg.Pool | null },
): Promise<{ stoppedForDayCap: boolean }> {
  if (!c.enableRpc || !c.solanaRpcHttpUrl) {
    return { stoppedForDayCap: false };
  }
  const perCall = creditsPerStandardSolanaRpc();
  const useLedger = Boolean(opts?.pgPool && qnLedgerEnvOn());
  let jsonRpcLedger:
    | ((pool: pg.Pool, o: Record<string, unknown>) => Promise<{ error?: unknown; result?: unknown }>)
    | null = null;
  if (useLedger) {
    // @ts-expect-error ESM `scripts-tmp/*.mjs` без деклараций типов (W6.13).
    const m = await import('../../../scripts-tmp/sa-qn-json-rpc.mjs');
    jsonRpcLedger = m.jsonRpcWithQnLedger;
  }

  for (const w of wallets) {
    if (counters.calls >= c.rpcBudget) {
      return { stoppedForDayCap: false };
    }
    if (seen.has(w)) {
      continue;
    }
    seen.add(w);

    if (useLedger && jsonRpcLedger && opts?.pgPool) {
      const j = await jsonRpcLedger(opts.pgPool, {
        rpcUrl: c.solanaRpcHttpUrl,
        componentId: 'scam_farm_rpc_probe',
        method: 'getAccountInfo',
        params: [w, { encoding: 'jsonParsed' }],
        timeoutMs: 15_000,
        credits: perCall,
      });
      const er = j.error as { code?: string } | undefined;
      if (er?.code === 'QN_GLOBAL_DAY_CAP') {
        return { stoppedForDayCap: true };
      }
      if (!j.error && j.result !== undefined) {
        counters.calls += 1;
      }
      continue;
    }

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [w, { encoding: 'jsonParsed' }],
    };
    const res = await fetch(c.solanaRpcHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      counters.calls += 1;
      await recordSolanaRpcCredits(perCall);
    }
  }
  return { stoppedForDayCap: false };
}
