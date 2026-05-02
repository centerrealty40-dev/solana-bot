import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as qnClient from '../src/core/rpc/qn-client.js';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  liveSimulateSignedTransaction,
  parseLiveSimulateRpcResult,
  signLiveJupiterSwapBase64,
} from '../src/live/simulate.js';

function baseCfg(over: Partial<LiveOscarConfig> = {}): LiveOscarConfig {
  return {
    strategyEnabled: true,
    executionMode: 'simulate',
    profile: 'oscar',
    liveTradesPath: '/tmp/live-p3-test.jsonl',
    strategyId: 'live-oscar',
    heartbeatIntervalMs: 60_000,
    liveJupiterQuoteTimeoutMs: 5000,
    liveJupiterSwapTimeoutMs: 8000,
    liveDefaultSlippageBps: 400,
    liveSimEnabled: true,
    liveSimTimeoutMs: 12_000,
    liveSimCreditsPerCall: 30,
    liveSimReplaceRecentBlockhash: true,
    liveSimSigVerify: false,
    walletSecret: 'dummy',
    ...over,
  } as LiveOscarConfig;
}

describe('parseLiveSimulateRpcResult', () => {
  it('reads nested RPC result.value', () => {
    const r = parseLiveSimulateRpcResult({
      context: { slot: 1 },
      value: { err: null, unitsConsumed: 99, logs: ['first'] },
    });
    expect(r.err).toBeNull();
    expect(r.units).toBe(99);
    expect(r.log0).toBe('first');
  });

  it('treats false err as success', () => {
    const r = parseLiveSimulateRpcResult({ err: false, unitsConsumed: 1 });
    expect(r.err).toBeNull();
    expect(r.units).toBe(1);
  });

  it('surfaces simulation failure', () => {
    const r = parseLiveSimulateRpcResult({
      value: { err: 'InstructionError', logs: [] },
    });
    expect(r.err).toBe('InstructionError');
  });
});

describe('liveSimulateSignedTransaction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok when qnCall returns clean simulate result', async () => {
    vi.spyOn(qnClient, 'qnCall').mockResolvedValue({
      ok: true,
      value: { value: { err: null, unitsConsumed: 42 } },
    });

    const out = await liveSimulateSignedTransaction({
      cfg: baseCfg(),
      signedTxSerializedBase64: 'AA',
    });

    expect(out).toEqual({ ok: true, unitsConsumed: 42 });
    expect(qnClient.qnCall).toHaveBeenCalledWith(
      'simulateTransaction',
      [
        'AA',
        {
          encoding: 'base64',
          commitment: 'processed',
          replaceRecentBlockhash: true,
          sigVerify: false,
          innerInstructions: false,
        },
      ],
      { feature: 'sim', creditsPerCall: 30, timeoutMs: 12_000 },
    );
  });

  it('maps qn budget failure', async () => {
    vi.spyOn(qnClient, 'qnCall').mockResolvedValue({ ok: false, reason: 'budget' });

    const out = await liveSimulateSignedTransaction({
      cfg: baseCfg(),
      signedTxSerializedBase64: 'AA',
    });

    expect(out).toEqual({ ok: false, kind: 'qn_budget', message: undefined });
  });

  it('maps simulation error', async () => {
    vi.spyOn(qnClient, 'qnCall').mockResolvedValue({
      ok: true,
      value: { value: { err: { Custom: 1 }, unitsConsumed: 10 } },
    });

    const out = await liveSimulateSignedTransaction({
      cfg: baseCfg(),
      signedTxSerializedBase64: 'AA',
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe('sim_failed');
      expect(out.unitsConsumed).toBe(10);
    }
  });
});

describe('signLiveJupiterSwapBase64', () => {
  it('round-trips sign with fee payer keypair', () => {
    const payer = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);

    const unsigned = Buffer.from(vtx.serialize()).toString('base64');
    const signed = signLiveJupiterSwapBase64(unsigned, payer);

    const restored = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
    expect(restored.signatures.some((s) => s.every((b) => b === 0))).toBe(false);
    expect(restored.message.staticAccountKeys[0]?.equals(payer.publicKey)).toBe(true);
  });
});
