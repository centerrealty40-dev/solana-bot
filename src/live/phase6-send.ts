/**
 * W8.0 Phase 6 — sendTransaction + getSignatureStatuses confirm (live-oscar).
 */
import { qnCall } from '../core/rpc/qn-client.js';
import type { LiveConfirmCommitmentLevel, LiveOscarConfig } from './config.js';
import { liveSimulateSignedTransaction } from './simulate.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rank comparison for RPC confirmationStatus vs required minimum. */
export function confirmationMeetsRequirement(
  confirmationStatus: string | undefined,
  required: LiveConfirmCommitmentLevel,
): boolean {
  const rank = (s: string | undefined): number => {
    if (s === 'finalized') return 3;
    if (s === 'confirmed') return 2;
    if (s === 'processed') return 1;
    return 0;
  };
  return rank(confirmationStatus) >= rank(required);
}

export function isLiveSendRetryableRpcMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('too many requests') ||
    m.includes('timeout') ||
    m.includes('blockhash') ||
    m.includes('timed out') ||
    m.includes('fetch failed') ||
    m.includes('econnreset')
  );
}

type SigRow = {
  confirmationStatus?: string;
  err?: unknown;
  slot?: number;
};

/**
 * Solana `getSignatureStatuses` → `result` is `{ context, value: (SignatureStatus|null)[] }`.
 * Some proxies return the array bare; Phase 6 must accept both or polling never sees status → `confirm_timeout`.
 */
function signatureStatusArrayFromRpcResult(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const v = (raw as { value: unknown }).value;
    if (Array.isArray(v)) return v;
  }
  return null;
}

function firstSignatureStatus(raw: unknown): SigRow | null {
  const arr = signatureStatusArrayFromRpcResult(raw);
  if (!arr || arr.length === 0) return null;
  const x = arr[0];
  if (x == null) return null;
  if (typeof x !== 'object') return null;
  return x as SigRow;
}

function signatureRowFailed(row: SigRow): boolean {
  const e = row.err;
  if (e == null || e === false) return false;
  return true;
}

function liveRpcBase(cfg: LiveOscarConfig) {
  return {
    feature: 'live_send' as const,
    creditsPerCall: cfg.liveSendCreditsPerCall,
    timeoutMs: cfg.liveSendRpcTimeoutMs,
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

/**
 * If `getSignatureStatuses` polling times out (e.g. misconfigured node) but the tx landed,
 * accept success when `getTransaction` returns a committed tx with `meta.err == null`.
 */
async function tryRecoverConfirmedViaGetTransaction(args: {
  cfg: LiveOscarConfig;
  signature: string;
}): Promise<{ ok: true; slot: number | null } | { ok: false }> {
  const res = await qnCall<unknown>(
    'getTransaction',
    [
      args.signature,
      {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: args.cfg.liveConfirmCommitment,
      },
    ],
    {
      ...liveRpcBase(args.cfg),
      timeoutMs: Math.min(20_000, Math.max(5000, args.cfg.liveSendRpcTimeoutMs)),
    },
  );
  if (!res.ok) return { ok: false };
  const tx = res.value as { meta?: { err?: unknown }; slot?: number } | null;
  if (tx == null || typeof tx !== 'object') return { ok: false };
  const err = tx.meta?.err;
  if (err != null && err !== false) return { ok: false };
  const slot = tx.slot;
  return {
    ok: true,
    slot: typeof slot === 'number' && Number.isFinite(slot) ? slot : null,
  };
}

async function sendTransactionOnce(
  cfg: LiveOscarConfig,
  signedTxSerializedBase64: string,
): Promise<{ ok: true; signature: string } | { ok: false; message: string }> {
  const res = await qnCall<string>(
    'sendTransaction',
    [
      signedTxSerializedBase64,
      {
        encoding: 'base64',
        skipPreflight: cfg.liveSendSkipPreflight,
        maxRetries: 0,
      },
    ],
    liveRpcBase(cfg),
  );

  if (!res.ok) {
    return { ok: false, message: `${res.reason}${res.message ? `:${res.message.slice(0, 400)}` : ''}` };
  }
  const sig = res.value;
  if (typeof sig !== 'string' || sig.length < 32) {
    return { ok: false, message: 'send_empty_or_invalid_signature' };
  }
  return { ok: true, signature: sig };
}

async function pollUntilConfirmed(args: {
  cfg: LiveOscarConfig;
  signature: string;
  deadlineMs: number;
}): Promise<
  | { ok: true; slot: number | null }
  | { ok: false; kind: 'confirm_timeout' | 'chain_err'; message: string }
> {
  const { cfg, signature, deadlineMs } = args;
  const pollTimeout = Math.min(8000, Math.max(2000, cfg.liveConfirmTimeoutMs));

  while (Date.now() < deadlineMs) {
    const res = await qnCall<unknown>(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
      {
        ...liveRpcBase(cfg),
        timeoutMs: pollTimeout,
      },
    );

    if (!res.ok) {
      await sleep(450);
      continue;
    }

    const row = firstSignatureStatus(res.value);
    if (row == null) {
      await sleep(450);
      continue;
    }

    if (signatureRowFailed(row)) {
      const msg =
        typeof row.err === 'object' ? JSON.stringify(row.err).slice(0, 500) : String(row.err ?? 'chain_err');
      return { ok: false, kind: 'chain_err', message: msg };
    }

    if (confirmationMeetsRequirement(row.confirmationStatus, cfg.liveConfirmCommitment)) {
      const slot = typeof row.slot === 'number' && Number.isFinite(row.slot) ? row.slot : null;
      return { ok: true, slot };
    }

    await sleep(450);
  }

  return { ok: false, kind: 'confirm_timeout', message: 'confirm_timeout' };
}

export type LiveSendPipelineOutcome =
  | { ok: true; signature: string; slot: number | null; preSimUnits: number | null }
  | {
      ok: false;
      kind: 'sim_err' | 'send_failed' | 'confirm_timeout' | 'chain_err';
      message: string;
      signature?: string | null;
      preSimUnits?: number | null;
    };

/**
 * Pre-send optional simulate → sendTransaction (retries) → confirm (single execution_result worth of work).
 */
export async function liveSendSignedSwapPipeline(args: {
  cfg: LiveOscarConfig;
  signedTxSerializedBase64: string;
}): Promise<LiveSendPipelineOutcome> {
  const { cfg, signedTxSerializedBase64 } = args;

  let preSimUnits: number | null = null;

  if (cfg.liveSimBeforeSend) {
    const sim = await liveSimulateSignedTransaction({
      cfg,
      signedTxSerializedBase64,
    });
    if (!sim.ok) {
      return {
        ok: false,
        kind: 'sim_err',
        message: sim.kind + (sim.message ? `:${sim.message.slice(0, 400)}` : ''),
        preSimUnits: sim.unitsConsumed ?? null,
      };
    }
    preSimUnits = sim.unitsConsumed ?? null;
  }

  let signature: string | null = null;
  const maxAttempts = cfg.liveSendMaxRetries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sent = await sendTransactionOnce(cfg, signedTxSerializedBase64);
    if (sent.ok) {
      signature = sent.signature;
      break;
    }
    const retryable = isLiveSendRetryableRpcMessage(sent.message);
    if (!retryable || attempt >= maxAttempts - 1) {
      return { ok: false, kind: 'send_failed', message: sent.message, preSimUnits };
    }
    await sleep(cfg.liveSendRetryBaseMs * (attempt + 1));
  }

  if (!signature) {
    return { ok: false, kind: 'send_failed', message: 'send_failed_no_signature', preSimUnits };
  }

  const deadline = Date.now() + cfg.liveConfirmTimeoutMs;
  const polled = await pollUntilConfirmed({ cfg, signature, deadlineMs: deadline });

  if (!polled.ok) {
    if (polled.kind === 'confirm_timeout' && signature) {
      const recovered = await tryRecoverConfirmedViaGetTransaction({ cfg, signature });
      if (recovered.ok) {
        return {
          ok: true,
          signature,
          slot: recovered.slot,
          preSimUnits,
        };
      }
    }
    return {
      ok: false,
      kind: polled.kind,
      message: polled.message,
      signature,
      preSimUnits,
    };
  }

  return {
    ok: true,
    signature,
    slot: polled.slot,
    preSimUnits,
  };
}
