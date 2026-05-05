/**
 * W6.12 S02 — wallet-centric backfill: ограниченный RPC → `swaps` (pump.fun) + `money_flows` (SOL transfer).
 *
 *   npm run wallet-backfill:run
 *   npm run wallet-backfill:run -- --enqueue-from-wallets=2000
 *   npm run wallet-backfill:run -- --enqueue-from-wallets=500 --dry-run   # S06: только расчёт gate, без INSERT
 *
 * Env: см. `.env.example` (SA_BACKFILL_*). Требуется миграция `0018_wallet_backfill_queue`.
 */
import 'dotenv/config';
import pg from 'pg';
import { db, schema, sql as pgSqlClient } from '../core/db/client.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { decodePumpfunSwap, PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { insertSwaps, touchTokensAndWallets } from '../parser/writer.js';
import { extractNativeSolTransfers } from '../intel/wallet-backfill-sol-flows.js';
import {
  computeEnqueueBatchSize,
  parseOptionalPositiveIntEnv,
} from '../intel/wallet-backfill-enqueue-gate.js';

const { Pool } = pg;

type SaQnJsonRpcMod = {
  jsonRpcWithQnLedger: (
    pool: pg.Pool,
    opts: {
      rpcUrl: string;
      componentId: string;
      method: string;
      params?: unknown;
      timeoutMs?: number;
      credits?: number;
    },
  ) => Promise<{ error?: unknown; result?: unknown }>;
};

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function pickRpcUrl(): string {
  return (
    process.env.SA_BACKFILL_RPC_URL?.trim() ||
    process.env.SA_RPC_HTTP_URL?.trim() ||
    process.env.SA_ORCH_RPC_URL?.trim() ||
    process.env.QUICKNODE_HTTP_URL?.trim() ||
    ''
  );
}

async function loadQnJsonRpc(): Promise<SaQnJsonRpcMod> {
  // @ts-expect-error ESM `scripts-tmp/*.mjs` без деклараций типов (W6.12 S03).
  const m: unknown = await import('../../scripts-tmp/sa-qn-json-rpc.mjs');
  return m as SaQnJsonRpcMod;
}

async function rpcJsonRpc(
  poolPg: pg.Pool,
  jr: SaQnJsonRpcMod,
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const timeoutMs = envNum('SA_BACKFILL_HTTP_TIMEOUT_MS', 15_000);
  const j = await jr.jsonRpcWithQnLedger(poolPg, {
    rpcUrl,
    componentId: 'wallet_backfill',
    method,
    params,
    timeoutMs,
  });
  if (j.error) {
    const er = j.error as { code?: string; message?: string; creditsRemaining?: number; dailyCap?: number };
    if (er.code === 'QN_GLOBAL_DAY_CAP') {
      throw Object.assign(new Error('QN_GLOBAL_DAY_CAP'), er);
    }
    throw new Error(er.message || String(j.error));
  }
  return j.result;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let enqueueFromWallets: number | null = null;
  for (const a of argv) {
    if (a.startsWith('--enqueue-from-wallets=')) {
      const n = Number(a.split('=')[1]);
      if (Number.isFinite(n) && n > 0) enqueueFromWallets = Math.floor(n);
    }
  }
  const dryRun = argv.includes('--dry-run');
  return { enqueueFromWallets, dryRun };
}

async function countPendingQueue(pool: pg.Pool): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS c FROM wallet_backfill_queue WHERE status = 'pending'`);
  const row = res.rows[0] as { c?: number } | undefined;
  return row?.c ?? 0;
}

async function enqueueFromWallets(pool: pg.Pool, limit: number): Promise<number> {
  const res = await pool.query(
    `INSERT INTO wallet_backfill_queue (address, status, priority)
     SELECT w.address, 'pending',
       CASE COALESCE(w.metadata->>'seed_lane', '')
         WHEN 'pumpswap' THEN 100
         WHEN 'raydium' THEN 80
         WHEN 'meteora' THEN 70
         WHEN 'orca' THEN 60
         WHEN 'moonshot' THEN 50
         ELSE 0
       END
     FROM wallets w
     WHERE NOT EXISTS (SELECT 1 FROM wallet_backfill_queue q WHERE q.address = w.address)
     ORDER BY
       CASE COALESCE(w.metadata->>'seed_lane', '')
         WHEN 'pumpswap' THEN 100
         WHEN 'raydium' THEN 80
         WHEN 'meteora' THEN 70
         WHEN 'orca' THEN 60
         WHEN 'moonshot' THEN 50
         ELSE 0
       END DESC,
       w.first_seen_at DESC NULLS LAST
     LIMIT $1::int
     ON CONFLICT (address) DO NOTHING`,
    [limit],
  );
  return res.rowCount ?? 0;
}

async function pickBatch(pool: pg.Pool, batch: number): Promise<string[]> {
  const res = await pool.query(
    `SELECT q.address
     FROM wallet_backfill_queue q
     LEFT JOIN wallets w ON w.address = q.address
     WHERE q.status IN ('pending', 'done')
     ORDER BY
       q.priority DESC,
       CASE COALESCE(w.metadata->>'seed_lane', '')
         WHEN 'pumpswap' THEN 100
         WHEN 'raydium' THEN 80
         WHEN 'meteora' THEN 70
         WHEN 'orca' THEN 60
         WHEN 'moonshot' THEN 50
         ELSE 0
       END DESC,
       q.last_run_at ASC NULLS FIRST
     LIMIT $1::int`,
    [batch],
  );
  return res.rows.map((r: { address: string }) => r.address);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { enqueueFromWallets: enqueueN, dryRun } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL || process.env.SA_PG_DSN;
  if (!databaseUrl) {
    console.error('[fatal] DATABASE_URL or SA_PG_DSN required');
    process.exit(1);
  }

  // @ts-expect-error ESM `scripts-tmp/*.mjs` без деклараций типов (W6.13).
  const budgetMod = await import('../../scripts-tmp/sa-qn-global-budget-lib.mjs');
  budgetMod.logOperationalBudgetWarnings(process.env, { component: 'wallet-backfill' });

  const poolPg = new Pool({ connectionString: databaseUrl });

  try {
    if (enqueueN !== null) {
      const pendingCount = await countPendingQueue(poolPg);
      const gatePendingMax = parseOptionalPositiveIntEnv(process.env.SA_BACKFILL_ENQUEUE_GATE_PENDING_MAX);
      const softCap = parseOptionalPositiveIntEnv(process.env.SA_BACKFILL_ENQUEUE_SOFT_CAP);
      const gate = computeEnqueueBatchSize({
        pendingCount,
        requested: enqueueN,
        gatePendingMax,
        softCap,
      });

      if (dryRun) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              component: 'wallet-backfill',
              mode: 'enqueue',
              dry_run: true,
              pending_count: pendingCount,
              requested: enqueueN,
              effective_n: gate.effectiveN,
              gate_skipped: gate.skipped,
              gate_reason: gate.reason,
              gate_pending_max: gatePendingMax,
              soft_cap: softCap,
            },
            null,
            2,
          ),
        );
        return;
      }

      if (gate.effectiveN <= 0) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              component: 'wallet-backfill',
              enqueued: 0,
              pending_count_before: pendingCount,
              requested: enqueueN,
              gate,
            },
            null,
            2,
          ),
        );
        return;
      }

      const n = await enqueueFromWallets(poolPg, gate.effectiveN);
      console.log(
        JSON.stringify(
          {
            ok: true,
            component: 'wallet-backfill',
            enqueued: n,
            pending_count_before: pendingCount,
            requested: enqueueN,
            gate,
          },
          null,
          2,
        ),
      );
      return;
    }

    const rpcUrl = pickRpcUrl();
    if (!rpcUrl) {
      console.error('[fatal] SA_BACKFILL_RPC_URL or SA_RPC_HTTP_URL required');
      process.exit(1);
    }

    const jr = await loadQnJsonRpc();

    if (process.env.SA_BACKFILL_ENABLED !== '1') {
      console.error('[fatal] SA_BACKFILL_ENABLED=1 required for run (safety gate)');
      process.exit(1);
    }

    const maxWallets = envNum('SA_BACKFILL_MAX_WALLETS_PER_RUN', 500);
    const sigPagesMax = envNum('SA_BACKFILL_SIG_PAGES_MAX', 3);
    const maxTx = envNum('SA_BACKFILL_MAX_TX_PER_WALLET', 40);
    const rpcSleep = envNum('SA_BACKFILL_RPC_SLEEP_MS', 220);
    const pumpProgram = envStr('SA_PARSER_PROGRAM_ID', PUMP_FUN_PROGRAM_ID);
    const solUsd = envNum('SA_SOL_USD_FALLBACK', 150);

    const addresses = await pickBatch(poolPg, maxWallets);
    if (addresses.length === 0) {
      console.log(
        JSON.stringify({
          ok: true,
          component: 'wallet-backfill',
          warning: 'queue empty — run with --enqueue-from-wallets=N',
          wallets: 0,
        }),
        null,
        2,
      );
      return;
    }

    let swapsInserted = 0;
    let flowsInserted = 0;
    let txFetched = 0;

    for (const wallet of addresses) {
      await poolPg.query(`UPDATE wallet_backfill_queue SET status = 'running', error_message = NULL WHERE address = $1`, [
        wallet,
      ]);

      let before: string | undefined;
      let txForWallet = 0;

      try {
        for (let page = 0; page < sigPagesMax; page += 1) {
          if (txForWallet >= maxTx) break;
          const opts: { limit: number; before?: string } = { limit: 100 };
          if (before) opts.before = before;

          const sigChunk = (await rpcJsonRpc(poolPg, jr, rpcUrl, 'getSignaturesForAddress', [
            wallet,
            opts,
          ])) as Array<{ signature?: string; err?: unknown }> | null;

          await sleep(rpcSleep);

          if (!Array.isArray(sigChunk) || sigChunk.length === 0) break;

          for (const row of sigChunk) {
            if (txForWallet >= maxTx) break;
            const sig = row.signature;
            if (!sig || row.err) continue;

            const txJson = (await rpcJsonRpc(poolPg, jr, rpcUrl, 'getTransaction', [
              sig,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
            ])) as TxJsonParsed | null;

            txForWallet += 1;
            txFetched += 1;
            await sleep(rpcSleep);

            if (!txJson || txJson.meta?.err != null) continue;

            const swaps = decodePumpfunSwap(txJson, pumpProgram, solUsd).map((s) => ({
              ...s,
              source: 'wallet_backfill',
            }));

            const bt = txJson.blockTime;
            const blockTime =
              typeof bt === 'number' && Number.isFinite(bt) ? new Date(bt * 1000) : new Date();

            if (!dryRun && swaps.length > 0) {
              const ins = await insertSwaps(swaps);
              swapsInserted += ins;
              await touchTokensAndWallets(swaps);
            }

            const flows = extractNativeSolTransfers(txJson);
            if (!dryRun && flows.length > 0) {
              for (const leg of flows) {
                await db
                  .insert(schema.moneyFlows)
                  .values({
                    sourceWallet: leg.sourceWallet,
                    targetWallet: leg.targetWallet,
                    asset: 'SOL',
                    amount: leg.amount,
                    txTime: blockTime,
                    signature: sig,
                  })
                  .onConflictDoNothing({
                    target: [
                      schema.moneyFlows.signature,
                      schema.moneyFlows.sourceWallet,
                      schema.moneyFlows.targetWallet,
                      schema.moneyFlows.asset,
                    ],
                  });
                flowsInserted += 1;
              }
            }
          }

          before = sigChunk[sigChunk.length - 1]?.signature;
          if (!before || sigChunk.length < 100) break;
        }

        await poolPg.query(
          `UPDATE wallet_backfill_queue
           SET status = 'done', last_run_at = now(), runs_count = runs_count + 1, sig_cursor = $2
           WHERE address = $1`,
          [wallet, before ?? null],
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code) : '';
        await poolPg.query(
          `UPDATE wallet_backfill_queue SET status = 'error', error_message = $2, last_run_at = now() WHERE address = $1`,
          [wallet, msg.slice(0, 2000)],
        );
        if (code === 'QN_GLOBAL_DAY_CAP') {
          console.log(
            JSON.stringify({
              ok: false,
              component: 'wallet-backfill',
              code: 'QN_GLOBAL_DAY_CAP',
              partial: { swapsInserted, flowsInserted, txFetched },
            }),
            null,
            2,
          );
          process.exit(0);
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          component: 'wallet-backfill',
          dryRun,
          wallets: addresses.length,
          txFetched,
          swapsInserted,
          flowsInsertedAttempted: flowsInserted,
        },
        null,
        2,
      ),
    );
  } finally {
    await poolPg.end();
    await pgSqlClient.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
