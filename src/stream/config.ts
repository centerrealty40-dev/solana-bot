import { z } from 'zod';
import { child } from '../core/logger.js';

const log = child('stream-config');

function httpToWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  throw new Error(`SA_RPC_HTTP_URL must start with http(s)://, got: ${httpUrl.slice(0, 24)}…`);
}

function pickRpcHttpUrl(): string {
  const direct = process.env.SA_RPC_HTTP_URL?.trim();
  if (direct) return direct;

  const qn = process.env.QUICKNODE_HTTP_URL?.trim();
  if (qn) {
    log.warn('SA_RPC_HTTP_URL missing — using QUICKNODE_HTTP_URL');
    return qn;
  }

  const helius = process.env.HELIUS_RPC_URL?.trim();
  if (helius) {
    log.warn('SA_RPC_HTTP_URL missing — using HELIUS_RPC_URL fallback');
    return helius;
  }

  throw new Error(
    'Need SA_RPC_HTTP_URL, or QUICKNODE_HTTP_URL, or HELIUS_RPC_URL for sa-stream HTTP RPC base',
  );
}

const StreamEnvSchema = z.object({
  rpcHttpUrl: z.string().url(),
  rpcWsUrl: z.string().url(),
  programIds: z.array(z.string().min(32).max(64)).min(1),
  commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  batchSize: z.coerce.number().int().min(1).max(500).default(50),
  batchMs: z.coerce.number().int().min(50).max(60_000).default(1000),
  reconnectMinMs: z.coerce.number().int().min(100).max(60_000).default(1000),
  reconnectMaxMs: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  logEveryN: z.coerce.number().int().min(1).max(50_000).default(500),
});

export type StreamConfig = z.infer<typeof StreamEnvSchema>;

export function loadStreamConfig(): StreamConfig {
  const rpcHttpUrl = pickRpcHttpUrl();
  const wsExplicit = process.env.SA_RPC_WS_URL?.trim();
  const rpcWsUrl = wsExplicit && wsExplicit.length > 0 ? wsExplicit : httpToWsUrl(rpcHttpUrl);

  const idsRaw = process.env.SA_STREAM_PROGRAM_IDS?.trim();
  const defaultPump = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const programIds = (idsRaw ? idsRaw.split(',') : [defaultPump])
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed = StreamEnvSchema.safeParse({
    rpcHttpUrl,
    rpcWsUrl,
    programIds,
    commitment: process.env.SA_STREAM_COMMITMENT,
    batchSize: process.env.SA_STREAM_BATCH_SIZE,
    batchMs: process.env.SA_STREAM_BATCH_MS,
    reconnectMinMs: process.env.SA_STREAM_RECONNECT_MIN_MS,
    reconnectMaxMs: process.env.SA_STREAM_RECONNECT_MAX_MS,
    logEveryN: process.env.SA_STREAM_LOG_EVERY_N,
  });

  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`sa-stream env: ${msg}`);
  }

  return parsed.data;
}
