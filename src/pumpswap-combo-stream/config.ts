import 'dotenv/config';
import { z } from 'zod';
import { PUMP_SWAP_AMM_PROGRAM_ID } from '../parser/allowlisted-dex-swap.js';
import { resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';

function httpToWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  throw new Error(`RPC HTTP URL must start with http(s)://`);
}

const ConfigSchema = z.object({
  rpcHttpUrl: z.string().url(),
  rpcWsUrl: z.string().url(),
  programId: z.string().min(32).max(64),
  commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  queueMax: z.coerce.number().int().min(50).max(5000).default(800),
  txFetchMinGapMs: z.coerce.number().int().min(100).max(5000).default(350),
  queueMaxAgeMs: z.coerce.number().int().min(30_000).max(600_000).default(120_000),
  logEveryN: z.coerce.number().int().min(10).max(50_000).default(200),
  snapshotSource: z.string().min(1).default('pumpswap-combo-stream'),
});

export type PumpswapComboStreamConfig = z.infer<typeof ConfigSchema>;

export function loadPumpswapComboStreamConfig(): PumpswapComboStreamConfig {
  const rpcHttpUrl =
    process.env.PUMPSWAP_COMBO_STREAM_RPC_HTTP?.trim() ||
    process.env.PUMPSWAP_COMBO_RPC_URL?.trim() ||
    resolveSolanaRpcUrl() ||
    '';
  if (!rpcHttpUrl) throw new Error('PUMPSWAP_COMBO_STREAM_RPC_HTTP or SA_RPC_HTTP_URL required');
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL required');

  const wsExplicit = process.env.PUMPSWAP_COMBO_STREAM_RPC_WS?.trim();
  const rpcWsUrl = wsExplicit || httpToWsUrl(rpcHttpUrl);

  return ConfigSchema.parse({
    rpcHttpUrl,
    rpcWsUrl,
    programId: process.env.PUMPSWAP_COMBO_STREAM_PROGRAM_ID?.trim() || PUMP_SWAP_AMM_PROGRAM_ID,
    commitment: process.env.PUMPSWAP_COMBO_STREAM_COMMITMENT,
    queueMax: process.env.PUMPSWAP_COMBO_STREAM_QUEUE_MAX,
    txFetchMinGapMs: process.env.PUMPSWAP_COMBO_STREAM_TX_GAP_MS,
    queueMaxAgeMs: process.env.PUMPSWAP_COMBO_STREAM_QUEUE_MAX_AGE_MS,
    logEveryN: process.env.PUMPSWAP_COMBO_STREAM_LOG_EVERY_N,
    snapshotSource: process.env.PUMPSWAP_COMBO_STREAM_SOURCE,
  });
}
