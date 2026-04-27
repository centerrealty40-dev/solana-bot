/**
 * Parser: rpc_features.feature_type='tx_for_signature' → swaps (Шаг 1b).
 *
 * Идёт по необработанным сырым транзакциям из `rpc_features` и пытается извлечь
 * один swap-event по signer'у (фронт-payer'у) транзакции:
 *   - signer + target_mint (delta token balance) + quote_mint (SOL/USDC/USDT delta)
 *   - amountUsd: USDC/USDT 1:1, SOL × PARSE_SOL_USD_FALLBACK (default 200)
 * dex определяется по programId инструкций (raydium / pumpfun / meteora / orca / unknown).
 *
 * Идемпотентен: помечает обработанные строки колонкой `processed boolean` (DDL ниже).
 *
 *   PARSE_BATCH=300                — сколько сырых tx обрабатывать за один запуск
 *   PARSE_SOL_USD_FALLBACK=200     — курс SOL→USD, если из transactions не вытянуть
 *   PARSE_DRY_RUN=1
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { insertSwapsBatch } from '../core/db/repository.js';
import type { NormalizedSwap } from '../core/types.js';

const log = child('parse-rpc-features-to-swaps');

const BATCH = Math.max(10, Math.min(Number(process.env.PARSE_BATCH || 300), 5000));
const SOL_USD_FALLBACK = Math.max(20, Math.min(Number(process.env.PARSE_SOL_USD_FALLBACK || 200), 5000));
const DRY = process.env.PARSE_DRY_RUN === '1';

const QUOTE_DECIMALS = new Map<string, number>([
  ['So11111111111111111111111111111111111111112', 9],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6],
  ['Es9vMFrzaCERmJfrF4H2FYD4LkNX54nJeFf9HYZ8sY2', 6],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6],
]);
const WSOL = 'So11111111111111111111111111111111111111112';

const PROGRAM_TO_DEX: Record<string, NormalizedSwap['dex']> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium',          // Raydium AMM v4
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium',           // Raydium CLMM (Concentrated)
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium',           // Raydium CPMM
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'meteora',            // Meteora DLMM
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'meteora',           // Meteora DAMM v1 (Dynamic AMM)
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'meteora',            // Meteora DAMM v2
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'orca',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun',          // PumpFun bonding curve
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'pumpswap',           // PumpSwap AMM (post-mig)
};

interface FeatureRow {
  id: number;
  data: { signature?: string; tx?: unknown };
}

async function ensureSchema(): Promise<void> {
  await db.execute(dsql.raw(`
    ALTER TABLE rpc_features
      ADD COLUMN IF NOT EXISTS processed boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS rpc_features_unprocessed_tx_idx
      ON rpc_features (id) WHERE feature_type = 'tx_for_signature' AND processed = false;
  `));
}

interface SignerOwnerEntry {
  pre: bigint;
  post: bigint;
  decimals: number;
}

interface ParsedTx {
  signature: string;
  slot: number;
  blockTime: Date;
  meta: {
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string; decimals?: number } }>;
    postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string; decimals?: number } }>;
    err?: unknown;
  };
  transaction: {
    message: {
      accountKeys?: Array<string | { pubkey?: string }>;
      instructions?: Array<{ programId?: string }>;
    };
  };
}

function parseSwap(raw: unknown): NormalizedSwap | null {
  const tx = raw as ParsedTx | null;
  if (!tx || !tx.meta || tx.meta.err) return null;
  const sig =
    (tx as { transaction?: { signatures?: string[] } }).transaction?.signatures?.[0] ??
    (raw as { signature?: string })?.signature ??
    null;
  if (!sig) return null;
  const blockTime = new Date(((raw as { blockTime?: number })?.blockTime ?? 0) * 1000);
  const slot = Number((raw as { slot?: number })?.slot ?? 0);

  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  if (!accountKeys.length) return null;
  const first = accountKeys[0];
  const signer = typeof first === 'string' ? first : first?.pubkey;
  if (!signer) return null;

  const owners = new Map<string, SignerOwnerEntry>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.owner !== signer || !b.mint) continue;
    owners.set(b.mint, {
      pre: BigInt(b.uiTokenAmount?.amount ?? '0'),
      post: 0n,
      decimals: b.uiTokenAmount?.decimals ?? 6,
    });
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner !== signer || !b.mint) continue;
    const cur = owners.get(b.mint);
    const post = BigInt(b.uiTokenAmount?.amount ?? '0');
    if (cur) {
      cur.post = post;
    } else {
      owners.set(b.mint, { pre: 0n, post, decimals: b.uiTokenAmount?.decimals ?? 6 });
    }
  }

  let target: { mint: string; deltaRaw: bigint; decimals: number } | null = null;
  let quote: { mint: string; deltaRaw: bigint; decimals: number } | null = null;
  for (const [mint, x] of owners) {
    const delta = x.post - x.pre;
    if (delta === 0n) continue;
    const abs = delta < 0n ? -delta : delta;
    if (QUOTE_DECIMALS.has(mint)) {
      const qabs = quote ? (quote.deltaRaw < 0n ? -quote.deltaRaw : quote.deltaRaw) : 0n;
      if (!quote || abs > qabs) quote = { mint, deltaRaw: delta, decimals: x.decimals };
    } else {
      const tabs = target ? (target.deltaRaw < 0n ? -target.deltaRaw : target.deltaRaw) : 0n;
      if (!target || abs > tabs) target = { mint, deltaRaw: delta, decimals: x.decimals };
    }
  }

  // SOL fallback (signer pre/post lamports)
  const pre = (tx.meta.preBalances ?? [])[0] ?? 0;
  const post = (tx.meta.postBalances ?? [])[0] ?? 0;
  const solDelta = post - pre;
  if (!quote && Math.abs(solDelta) > 1_000_000) {
    quote = { mint: WSOL, deltaRaw: BigInt(solDelta), decimals: 9 };
  }

  if (!target || !quote) return null;
  let side: 'buy' | 'sell';
  if (target.deltaRaw > 0n && quote.deltaRaw < 0n) side = 'buy';
  else if (target.deltaRaw < 0n && quote.deltaRaw > 0n) side = 'sell';
  else return null;

  const baseAmountRaw = target.deltaRaw < 0n ? -target.deltaRaw : target.deltaRaw;
  const quoteAmountRaw = quote.deltaRaw < 0n ? -quote.deltaRaw : quote.deltaRaw;

  let amountUsd = 0;
  if (quote.mint === WSOL) {
    amountUsd = (Number(quoteAmountRaw) / 1e9) * SOL_USD_FALLBACK;
  } else {
    amountUsd = Number(quoteAmountRaw) / 10 ** (QUOTE_DECIMALS.get(quote.mint) ?? 6);
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

  const baseDecimals = target.decimals ?? 6;
  const baseUi = Number(baseAmountRaw) / 10 ** baseDecimals;
  if (!Number.isFinite(baseUi) || baseUi <= 0) return null;
  const priceUsd = amountUsd / baseUi;

  const programIds = (tx.transaction?.message?.instructions ?? [])
    .map((ix) => ix.programId)
    .filter((p): p is string => Boolean(p));
  let dex: NormalizedSwap['dex'] = 'unknown';
  for (const pid of programIds) {
    const m = PROGRAM_TO_DEX[pid];
    if (m) {
      dex = m;
      break;
    }
  }

  return {
    signature: sig,
    slot,
    blockTime,
    wallet: signer,
    baseMint: target.mint,
    quoteMint: quote.mint,
    side,
    baseAmountRaw,
    quoteAmountRaw,
    priceUsd,
    amountUsd,
    dex,
    source: 'rpc_backfill',
  };
}

async function main(): Promise<void> {
  await ensureSchema();
  const r: unknown = await db.execute(dsql.raw(`
    SELECT id, data
    FROM rpc_features
    WHERE feature_type = 'tx_for_signature' AND processed = false
    ORDER BY id ASC
    LIMIT ${BATCH}
  `));
  const rows = (Array.isArray(r) ? r : ((r as { rows?: FeatureRow[] }).rows ?? [])) as FeatureRow[];
  if (!rows.length) {
    log.info('no unprocessed tx_for_signature rows');
    process.exit(0);
  }

  const swaps: NormalizedSwap[] = [];
  const ids: number[] = [];
  for (const row of rows) {
    ids.push(row.id);
    const raw = (row.data as { tx?: unknown; signature?: string } | null)?.tx ?? row.data;
    try {
      const parsed = parseSwap(raw);
      if (parsed) swaps.push(parsed);
    } catch (e) {
      log.warn({ id: row.id, err: String(e) }, 'parse failed');
    }
  }

  let inserted = 0;
  if (!DRY && swaps.length) {
    inserted = await insertSwapsBatch(swaps);
  }
  if (!DRY && ids.length) {
    const idsSql = ids.join(',');
    await db.execute(dsql.raw(`UPDATE rpc_features SET processed = true WHERE id IN (${idsSql})`));
  }

  log.info(
    { scanned: rows.length, parsed: swaps.length, inserted, dryRun: DRY },
    'parse-rpc-features-to-swaps done',
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
