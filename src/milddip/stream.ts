/**
 * Helius (or any Solana RPC) logsSubscribe on pump.fun / PumpSwap → hot mint universe
 * + optional signature enqueue for stream price sampling.
 *
 * DexScreener remains the liq/mcap/pc5m source; stream prices fill the trough
 * during cooldown so we can refuse bounce re-entries.
 */
import { resolveLeaderStreamWsUrl } from '../copytrader/leader-stream-ws.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { PUMP_SWAP_AMM_PROGRAM_ID } from '../parser/allowlisted-dex-swap.js';
import { extractMintCandidatesFromLogs } from '../scripts/awakening/awakening-mint-from-logs.js';
import type { StreamConfig } from '../stream/config.js';
import { LogsWsClient } from '../stream/rpc-ws.js';
import { mildDipHotMints } from './hot-mints.js';
import type { StreamPriceSampler } from './stream-price-sampler.js';

export type MildDipStreamHandle = { stop: () => void };

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

export function startMildDipHotMintStream(opts?: {
  wsUrl?: string | null;
  programIds?: string[];
  onMint?: (mint: string, tsMs: number) => void;
  /** When set, enqueue signature→price decode for watched mints. */
  priceSampler?: StreamPriceSampler | null;
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
    // 1.11.795 — still harvest mints from failed txs (mention logs). Skipping
    // the whole notification on `err` starved hot-mints / fast-path while the
    // open book was non-empty (buys only ran on stream when opens > 0).
    const mints = extractMintCandidatesFromLogs(n.logs);
    for (const mint of mints) {
      mildDipHotMints.note(mint, tsMs);
      opts?.onMint?.(mint, tsMs);
      // Price decode needs a successful swap meta — skip sampler on err txs.
      if (!n.err && opts?.priceSampler && n.signature) {
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
