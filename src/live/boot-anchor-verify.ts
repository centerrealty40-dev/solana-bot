/**
 * W8.0-p7.1 — optional boot verification of `entryLegSignatures` via `getTransaction` (live mode).
 */
import { qnCall } from '../core/rpc/qn-client.js';
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';

function liveRpcBase(cfg: LiveOscarConfig) {
  return {
    feature: 'live_send' as const,
    creditsPerCall: cfg.liveSendCreditsPerCall,
    timeoutMs: Math.min(25_000, Math.max(5000, cfg.liveSendRpcTimeoutMs)),
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

async function fetchTransactionMetaOk(
  cfg: LiveOscarConfig,
  signature: string,
): Promise<'ok' | 'failed_tx' | 'not_found' | 'rpc_err'> {
  const res = await qnCall<unknown>(
    'getTransaction',
    [
      signature,
      {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: cfg.liveConfirmCommitment,
      },
    ],
    liveRpcBase(cfg),
  );
  if (!res.ok) return 'rpc_err';
  const tx = res.value as { meta?: { err?: unknown } } | null;
  if (tx == null) return 'not_found';
  const err = tx.meta?.err;
  if (err != null && err !== false) return 'failed_tx';
  return 'ok';
}

export interface BootAnchorVerifyResult {
  open: Map<string, OpenTrade>;
  ghostDetails: Array<{ mint: string; reason: string }>;
  /** Any signature check hit RPC transport failure — do not auto-drop those mints. */
  rpcFailed: boolean;
  /** Mints that kept replay state because RPC failed mid-verify. */
  rpcPendingMints: string[];
}

/**
 * Drops chain-anchored positions whose buy signatures are missing, failed on-chain, or not found.
 * On RPC errors, keeps the mint and sets `rpcFailed` so reconcile can surface `rpc_fail`.
 */
export async function verifyReplayedOpenBuyAnchorsOnBoot(args: {
  liveCfg: LiveOscarConfig;
  open: Map<string, OpenTrade>;
}): Promise<BootAnchorVerifyResult> {
  const { liveCfg } = args;
  const out = new Map(args.open);
  const ghostDetails: BootAnchorVerifyResult['ghostDetails'] = [];
  const rpcPendingMints: string[] = [];
  let rpcFailed = false;

  for (const [mint, ot] of [...out.entries()]) {
    if (ot.liveAnchorMode === 'simulate') continue;
    const sigs = ot.entryLegSignatures ?? [];
    if (sigs.length === 0) {
      out.delete(mint);
      ghostDetails.push({ mint, reason: 'missing_entry_leg_signatures' });
      continue;
    }
    let mintRpcPending = false;
    let dropReason: string | null = null;
    for (const sig of sigs) {
      if (typeof sig !== 'string' || sig.length < 32) {
        dropReason = 'invalid_signature_string';
        break;
      }
      const st = await fetchTransactionMetaOk(liveCfg, sig);
      if (st === 'rpc_err') {
        rpcFailed = true;
        mintRpcPending = true;
        rpcPendingMints.push(mint);
        break;
      }
      if (st === 'not_found') {
        dropReason = 'tx_not_found';
        break;
      }
      if (st === 'failed_tx') {
        dropReason = 'tx_execution_err';
        break;
      }
    }
    if (mintRpcPending) continue;
    if (dropReason) {
      out.delete(mint);
      ghostDetails.push({ mint, reason: dropReason });
    }
  }

  return { open: out, ghostDetails, rpcFailed, rpcPendingMints };
}
