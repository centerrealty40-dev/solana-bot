/**
 * Helius (or any Solana RPC) logsSubscribe on pump.fun / PumpSwap → hot mint universe
 * + optional signature enqueue for stream price sampling.
 *
 * DexScreener remains the liq/mcap/pc5m source; stream prices fill the trough
 * during cooldown so we can refuse bounce re-entries.
 */
import { resolveLeaderStreamWsUrl } from '../copytrader/leader-stream-ws.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { PUMP_SWAP_AMM_PROGRAM_ID, decodeAllowlistedDexSwapInserts } from '../parser/allowlisted-dex-swap.js';
import { extractMintCandidatesFromLogs } from '../scripts/awakening/awakening-mint-from-logs.js';
import type { StreamConfig } from '../stream/config.js';
import { LogsWsClient } from '../stream/rpc-ws.js';
import { mildDipHotMints } from './hot-mints.js';
import { mildDipPriceRing } from './price-ring.js';
import type { StreamPriceSampler } from './stream-price-sampler.js';

export type MildDipStreamHandle = { stop: () => void };

const fallbackQueue: Array<{ signature: string; tsMs: number }> = [];
const fallbackSeen = new Set<string>();
let fallbackRunning = false;
let fallbackWindowStartMs = 0;
let fallbackWindowCount = 0;

export function resolveMildDipStreamWsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.MILD_DIP_STREAM_WS_URL?.trim() || '';
  if (explicit) return explicit;
  return resolveLeaderStreamWsUrl(env);
}

export function mildDipStreamProgramIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MILD_DIP_STREAM_PROGRAM_IDS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 32);
  }
  return [PUMP_FUN_PROGRAM_ID, PUMP_SWAP_AMM_PROGRAM_ID];
}

async function rpcJson(url: string, method: string, params: unknown[]): Promise<unknown> {
  const { fetch } = await import('undici');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) return null;
  return j.result ?? null;
}

function enqueueFallbackDecode(signature: string, tsMs: number, opts: {
  rpcUrl: string;
  onMint?: (mint: string, tsMs: number) => void;
  priceSampler?: StreamPriceSampler | null;
  maxPerMin: number;
  maxQueue: number;
}): void {
  if (!signature || fallbackSeen.has(signature)) return;
  fallbackSeen.add(signature);
  fallbackQueue.push({ signature, tsMs });
  while (fallbackQueue.length > opts.maxQueue) fallbackQueue.shift();
  if (!fallbackRunning) void runFallbackDecode(opts);
}

async function runFallbackDecode(opts: {
  rpcUrl: string;
  onMint?: (mint: string, tsMs: number) => void;
  priceSampler?: StreamPriceSampler | null;
  maxPerMin: number;
  maxQueue: number;
}): Promise<void> {
  fallbackRunning = true;
  try {
    while (fallbackQueue.length > 0) {
      const now = Date.now();
      if (now - fallbackWindowStartMs >= 60_000) {
        fallbackWindowStartMs = now;
        fallbackWindowCount = 0;
      }
      if (fallbackWindowCount >= opts.maxPerMin) {
        await new Promise((r) => setTimeout(r, Math.max(250, 60_000 - (now - fallbackWindowStartMs))));
        continue;
      }
      const job = fallbackQueue.shift()!;
      fallbackWindowCount += 1;
      try {
        const tx = await rpcJson(opts.rpcUrl, 'getTransaction', [
          job.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        ]);
        const swaps = decodeAllowlistedDexSwapInserts(
          tx as Parameters<typeof decodeAllowlistedDexSwapInserts>[0],
          PUMP_FUN_PROGRAM_ID,
          Number(process.env.SA_SOL_USD_FALLBACK ?? 150),
        );
        for (const s of swaps) {
          const mint = s.baseMint;
          if (!mint) continue;
          mildDipHotMints.note(mint, job.tsMs);
          opts.onMint?.(mint, job.tsMs);
          if (s.priceUsd > 0) {
            mildDipPriceRing.note(mint, s.priceUsd, { tsMs: job.tsMs, source: 'stream' });
          }
          opts.priceSampler?.enqueue(mint, job.signature, job.tsMs);
        }
      } catch {
        // Best-effort coverage fallback; the regular stream must stay hot.
      }
    }
  } finally {
    fallbackRunning = false;
  }
}

export function startMildDipHotMintStream(opts?: {
  wsUrl?: string | null;
  programIds?: string[];
  onMint?: (mint: string, tsMs: number) => void;
  /** When set, enqueue signature→price decode for watched mints. */
  priceSampler?: StreamPriceSampler | null;
  /** Optional bounded getTransaction fallback when logs do not expose a mint. */
  fallbackRpcUrl?: string | null;
  fallbackMaxPerMin?: number;
  fallbackMaxQueue?: number;
}): MildDipStreamHandle | null {
  const wsUrl = (opts?.wsUrl ?? resolveMildDipStreamWsUrl())?.trim() || '';
  if (!wsUrl) {
    console.warn('[mild-dip] stream enabled but no WS URL (set HELIUS_API_KEY or MILD_DIP_STREAM_WS_URL)');
    return null;
  }
  const programIds = opts?.programIds?.length ? opts.programIds : mildDipStreamProgramIds();
  if (programIds.length === 0) return null;

  const cfg: StreamConfig = {
    rpcHttpUrl: 'https://placeholder.local',
    rpcWsUrl: wsUrl,
    programIds,
    commitment: 'confirmed',
    batchSize: 50,
    batchMs: 1000,
    reconnectMinMs: 2000,
    reconnectMaxMs: 60_000,
    logEveryN: 2000,
  };

  const client = new LogsWsClient(cfg, (n) => {
    const tsMs = Date.now();
    if (n.err) return;
    const mints = extractMintCandidatesFromLogs(n.logs);
    if (mints.length === 0 && n.signature && opts?.fallbackRpcUrl) {
      enqueueFallbackDecode(n.signature, tsMs, {
        rpcUrl: opts.fallbackRpcUrl,
        onMint: opts.onMint,
        priceSampler: opts.priceSampler,
        maxPerMin: Math.max(1, Math.floor(opts.fallbackMaxPerMin ?? 45)),
        maxQueue: Math.max(1, Math.floor(opts.fallbackMaxQueue ?? 200)),
      });
      return;
    }
    for (const mint of mints) {
      mildDipHotMints.note(mint, tsMs);
      opts?.onMint?.(mint, tsMs);
      if (opts?.priceSampler && n.signature) {
        opts.priceSampler.enqueue(mint, n.signature, tsMs);
      }
    }
  });

  client.start();
  console.log(
    `[mild-dip] Helius/RPC logsSubscribe started programs=${programIds.length} host=${safeHost(wsUrl)}`,
  );
  return {
    stop: () => {
      client.stop();
      opts?.priceSampler?.stop();
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
