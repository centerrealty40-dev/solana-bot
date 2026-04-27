import type { ScamFarmConfig } from './config.js';
import { creditsPerStandardSolanaRpc, recordSolanaRpcCredits } from '../../core/rpc/solana-rpc-meter.js';

const seen = new Set<string>();

export type RpcCounters = { calls: number };

/**
 * Optional post-pass: JSON-RPC `getAccountInfo` (cheap) for top wallets, with hard cap + de-dupe.
 * URL: SOLANA_RPC_HTTP_URL / QUICKNODE (see config). Does not log full URL.
 */
export async function maybeAlchemyProbes(
  c: ScamFarmConfig,
  wallets: string[],
  counters: RpcCounters,
): Promise<void> {
  if (!c.enableRpc || !c.solanaRpcHttpUrl) {
    return;
  }
  const perCall = creditsPerStandardSolanaRpc();
  for (const w of wallets) {
    if (counters.calls >= c.rpcBudget) {
      return;
    }
    if (seen.has(w)) {
      continue;
    }
    seen.add(w);
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
}
