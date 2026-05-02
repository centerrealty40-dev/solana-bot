/**
 * W8.0 Phase 7 tail — optional sample verification of recent confirmed swap txs (P7-I4 soft anchor).
 */
import { qnCall } from '../core/rpc/qn-client.js';
import type { LiveOscarConfig } from './config.js';
import { readLiveJournalLinesBounded } from './replay-strategy-journal.js';

export interface TxAnchorSampleResult {
  checked: number;
  /** Confirmed journal signatures that RPC returned null for (missing / pruned). */
  notFound: string[];
  /** getTransaction RPC failures (excluding null slot). */
  rpcErrors: number;
}

function qnReadOpts(cfg: LiveOscarConfig) {
  return {
    feature: 'sim' as const,
    creditsPerCall: cfg.liveSimCreditsPerCall,
    timeoutMs: cfg.liveSimTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

/** Scan newest-first within bounded journal bytes; dedupe signatures while preserving recency order. */
export function collectRecentConfirmedTxSignatures(opts: {
  storePath: string;
  strategyId: string;
  limit: number;
  maxFileBytes: number;
}): string[] {
  const { lines } = readLiveJournalLinesBounded(opts.storePath, opts.maxFileBytes);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < opts.limit; i--) {
    const ln = lines[i]?.trim();
    if (!ln) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.channel !== 'live') continue;
    if (String(row.strategyId ?? '') !== opts.strategyId) continue;
    if (row.kind !== 'execution_result') continue;
    if (String(row.status ?? '') !== 'confirmed') continue;
    const sig = row.txSignature;
    if (typeof sig !== 'string' || sig.length < 32) continue;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(sig);
  }
  return out;
}

export async function verifyTxAnchorSample(cfg: LiveOscarConfig, signatures: string[]): Promise<TxAnchorSampleResult> {
  const notFound: string[] = [];
  let rpcErrors = 0;
  const opts = qnReadOpts(cfg);
  for (const sig of signatures) {
    const res = await qnCall<unknown>(
      'getTransaction',
      [sig, { encoding: 'json', commitment: cfg.liveConfirmCommitment, maxSupportedTransactionVersion: 0 }],
      opts,
    );
    if (!res.ok) {
      rpcErrors += 1;
      continue;
    }
    if (res.value == null) notFound.push(sig);
  }
  return { checked: signatures.length, notFound, rpcErrors };
}
