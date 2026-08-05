/**
 * Helius (or any Solana RPC) logsSubscribe on pump.fun / PumpSwap → hot mint universe.
 * Does not replace DexScreener for the mild-dip gate (pc5m); only feeds candidates.
 */
import { resolveLeaderStreamWsUrl } from '../copytrader/leader-stream-ws.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { PUMP_SWAP_AMM_PROGRAM_ID } from '../parser/allowlisted-dex-swap.js';
import { startAwakeningStreamWs } from '../scripts/awakening/awakening-stream-ws.js';
import { mildDipHotMints } from './hot-mints.js';

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
}): MildDipStreamHandle | null {
  const wsUrl = (opts?.wsUrl ?? resolveMildDipStreamWsUrl())?.trim() || '';
  if (!wsUrl) {
    console.warn('[mild-dip] stream enabled but no WS URL (set HELIUS_API_KEY or MILD_DIP_STREAM_WS_URL)');
    return null;
  }
  const programIds = opts?.programIds?.length ? opts.programIds : mildDipStreamProgramIds();
  if (programIds.length === 0) return null;

  const handle = startAwakeningStreamWs({
    rpcWsUrl: wsUrl,
    programIds,
    onMintActivity: (mint, tsMs) => {
      mildDipHotMints.note(mint, tsMs);
      opts?.onMint?.(mint, tsMs);
    },
  });

  console.log(
    `[mild-dip] Helius/RPC logsSubscribe started programs=${programIds.length} host=${safeHost(wsUrl)}`,
  );
  return handle;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
