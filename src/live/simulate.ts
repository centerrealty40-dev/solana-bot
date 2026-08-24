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

const MAX_SIMULATION_LOG_LINES = 8;
const MAX_SIMULATION_LOG_BYTES = 1_800;

/** Same shape as paper sim-audit parseSimulateResult (W7.8). */
export function parseLiveSimulateRpcResult(r: unknown): {
  err: unknown | null;
  units: number | null;
  log0: string | null;
  logs: string[];
} {
  if (r == null || typeof r !== 'object') {
    return { err: 'no-result', units: null, log0: null, logs: [] };
  }
  const root = r as Record<string, unknown>;
  const inner =
    root.value != null && typeof root.value === 'object'
      ? (root.value as SimValue)
      : (root as SimValue);
  const u = inner.unitsConsumed;
  const rawErr = inner.err !== undefined ? inner.err : root.err;
  const err = rawErr == null || rawErr === false ? null : rawErr;
  const logs = Array.isArray(inner.logs)
    ? inner.logs.filter((log): log is string => typeof log === 'string')
    : [];
  return {
    err,
    units: Number.isFinite(u) ? (u as number) : null,
    log0: logs[0] ?? null,
    logs,
  };
}

export function summarizeSimulationLogs(logs: string[]): {
  logs: string[];
  programId: string | null;
} {
  const failedProgram =
    [...logs]
      .reverse()
      .map((log) => log.match(/^Program ([^ ]+) failed:/)?.[1] ?? null)
      .find((programId): programId is string => programId != null) ?? null;
  const summarized: string[] = [];
  let bytes = 0;
  for (const raw of logs.slice(0, MAX_SIMULATION_LOG_LINES)) {
    const line = raw.slice(0, 400);
    const separatorBytes = summarized.length > 0 ? 1 : 0;
    const available = MAX_SIMULATION_LOG_BYTES - bytes - separatorBytes;
    if (available <= 0) break;
    const encoded = Buffer.from(line, 'utf8');
    const clipped = encoded.subarray(0, available).toString('utf8');
    summarized.push(clipped);
    bytes += separatorBytes + Buffer.byteLength(clipped, 'utf8');
    if (clipped.length < line.length) break;
  }
  return { logs: summarized, programId: failedProgram };
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
      simulationLogs?: string[];
      simulationProgramId?: string | null;
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
      httpUrl: cfg.liveRpcHttpUrl,
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

  const { err, units, logs } = parseLiveSimulateRpcResult(simRes.value);
  if (err != null) {
    const summary = summarizeSimulationLogs(logs);
    return {
      ok: false,
      kind: 'sim_failed',
      message: typeof err === 'object' ? JSON.stringify(err).slice(0, 500) : String(err),
      unitsConsumed: units,
      simulationLogs: summary.logs,
      simulationProgramId: summary.programId,
    };
  }

  return { ok: true, unitsConsumed: units };
}
