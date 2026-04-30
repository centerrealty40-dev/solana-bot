import { z } from 'zod';
import { child } from '../core/logger.js';

const log = child('parser-config');

/** Same RPC resolution as sa-stream — reuse env chain without importing WS deps. */
function pickRpcHttpUrl(): string {
  const direct = process.env.SA_RPC_HTTP_URL?.trim();
  if (direct) return direct;

  const qn = process.env.QUICKNODE_HTTP_URL?.trim();
  if (qn) {
    log.warn('SA_RPC_HTTP_URL missing — using QUICKNODE_HTTP_URL');
    return qn;
  }

  const sol = process.env.SOLANA_RPC_HTTP_URL?.trim();
  if (sol) {
    log.warn('SA_RPC_HTTP_URL missing — using SOLANA_RPC_HTTP_URL');
    return sol;
  }

  const helius = process.env.HELIUS_RPC_URL?.trim();
  if (helius) {
    log.warn('SA_RPC_HTTP_URL missing — using HELIUS_RPC_URL fallback');
    return helius;
  }

  throw new Error(
    'Need SA_RPC_HTTP_URL, or QUICKNODE_HTTP_URL, or SOLANA_RPC_HTTP_URL, or HELIUS_RPC_URL for sa-parser',
  );
}

const ParserEnvSchema = z.object({
  rpcHttpUrl: z.string().url(),
  programId: z.string().min(32).max(64).default('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  batchSize: z.coerce.number().int().min(1).max(500).default(25),
  tickMs: z.coerce.number().int().min(100).max(60_000).default(1500),
  rpcBatch: z.coerce.number().int().min(1).max(40).default(5),
  rpcTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(8000),
  lookbackHours: z.coerce.number().int().min(1).max(168).default(6),
  maxInflight: z.coerce.number().int().min(1).max(20).default(2),
  dryRun: z.coerce.boolean().default(false),
  logEveryN: z.coerce.number().int().min(1).max(100_000).default(200),
  /** TODO(W4.1): replace with live SOL/USD feed (Pyth / Jupiter / Birdeye). */
  solUsdFallback: z.coerce.number().positive().default(150.0),
});

export type ParserConfig = z.infer<typeof ParserEnvSchema>;

export function loadParserConfig(): ParserConfig {
  const rpcHttpUrl = pickRpcHttpUrl();
  const dry =
    String(process.env.SA_PARSER_DRY_RUN ?? '')
      .trim()
      .toLowerCase() === 'true' ||
    process.env.SA_PARSER_DRY_RUN === '1';

  const parsed = ParserEnvSchema.safeParse({
    rpcHttpUrl,
    programId: process.env.SA_PARSER_PROGRAM_ID,
    batchSize: process.env.SA_PARSER_BATCH_SIZE,
    tickMs: process.env.SA_PARSER_TICK_MS,
    rpcBatch: process.env.SA_PARSER_RPC_BATCH,
    rpcTimeoutMs: process.env.SA_PARSER_RPC_TIMEOUT_MS,
    lookbackHours: process.env.SA_PARSER_LOOKBACK_HOURS,
    maxInflight: process.env.SA_PARSER_MAX_INFLIGHT,
    dryRun: dry,
    logEveryN: process.env.SA_PARSER_LOG_EVERY_N,
    solUsdFallback: process.env.SA_SOL_USD_FALLBACK,
  });

  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`sa-parser env: ${msg}`);
  }

  return parsed.data;
}
