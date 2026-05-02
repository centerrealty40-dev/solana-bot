/**
 * W8.0 Phase 3 — sign Jupiter swap tx + simulateTransaction via qnCall (feature sim).
 */
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { qnCall } from '../core/rpc/qn-client.js';
import type { LiveOscarConfig } from './config.js';

type SimValue = {
  err?: unknown;
  logs?: string[];
  unitsConsumed?: number;
};

/** Same shape as paper sim-audit parseSimulateResult (W7.8). */
export function parseLiveSimulateRpcResult(r: unknown): {
  err: unknown | null;
  units: number | null;
  log0: string | null;
} {
  if (r == null || typeof r !== 'object') return { err: 'no-result', units: null, log0: null };
  const root = r as Record<string, unknown>;
  const inner = root.value != null && typeof root.value === 'object' ? (root.value as SimValue) : (root as SimValue);
  const u = inner.unitsConsumed;
  const rawErr = inner.err !== undefined ? inner.err : root.err;
  const err = rawErr == null || rawErr === false ? null : rawErr;
  const logs = inner.logs;
  const log0 = Array.isArray(logs) && typeof logs[0] === 'string' ? logs[0] : null;
  return {
    err,
    units: Number.isFinite(u) ? (u as number) : null,
    log0,
  };
}

/** Deserialize Jupiter `swapTransaction` base64, sign with fee payer, return serialized base64 for RPC. */
export function signLiveJupiterSwapBase64(unsignedB64: string, signer: Keypair): string {
  const buf = Buffer.from(unsignedB64, 'base64');
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([signer]);
  return Buffer.from(vtx.serialize()).toString('base64');
}

export type LiveSimulateOutcome =
  | { ok: true; unitsConsumed: number | null }
  | {
      ok: false;
      kind: 'qn_budget' | 'qn_rate' | 'qn_http' | 'qn_timeout' | 'qn_rpc_error' | 'sim_failed';
      message?: string;
      unitsConsumed?: number | null;
    };

export async function liveSimulateSignedTransaction(args: {
  cfg: LiveOscarConfig;
  signedTxSerializedBase64: string;
}): Promise<LiveSimulateOutcome> {
  const { cfg, signedTxSerializedBase64 } = args;

  const simRes = await qnCall<unknown>(
    'simulateTransaction',
    [
      signedTxSerializedBase64,
      {
        encoding: 'base64',
        commitment: 'processed',
        replaceRecentBlockhash: cfg.liveSimReplaceRecentBlockhash,
        sigVerify: cfg.liveSimSigVerify,
        innerInstructions: false,
      },
    ],
    {
      feature: 'sim',
      creditsPerCall: cfg.liveSimCreditsPerCall,
      timeoutMs: cfg.liveSimTimeoutMs,
    },
  );

  if (!simRes.ok) {
    return {
      ok: false,
      kind:
        simRes.reason === 'budget'
          ? 'qn_budget'
          : simRes.reason === 'rate'
            ? 'qn_rate'
            : simRes.reason === 'timeout'
              ? 'qn_timeout'
              : simRes.reason === 'rpc_error'
                ? 'qn_rpc_error'
                : 'qn_http',
      message: simRes.message,
    };
  }

  const { err, units } = parseLiveSimulateRpcResult(simRes.value);
  if (err != null) {
    return {
      ok: false,
      kind: 'sim_failed',
      message: typeof err === 'object' ? JSON.stringify(err).slice(0, 500) : String(err),
      unitsConsumed: units,
    };
  }

  return { ok: true, unitsConsumed: units };
}
