/**
 * W6.12 S03 — Sigseed: mint-scoped `getSignaturesForAddress` → pump.fun `swaps` (без stream).
 *
 *   npm run sigseed:enqueue              # лимит из SA_SIGSEED_ENQUEUE_BATCH (default 300)
 *   npm run sigseed:enqueue -- --from-dex=500
 *   npm run sigseed:run
 *
 * Gates: `SA_SIGSEED_ENQUEUE_ENABLED=1` (enqueue), `SA_SIGSEED_ENABLED=1` (run).
 * Миграция `0019_signatures_seed_queue`.
 */
import 'dotenv/config';
import pg from 'pg';
import { sql as pgSqlClient } from '../core/db/client.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { decodePumpfunSwap, PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { insertSwaps, touchTokensAndWallets } from '../parser/writer.js';

const { Pool } = pg;

const ADVISORY_LOCK_KEY = 941_337_041;

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
    process.env.SA_SIGSEED_RPC_URL?.trim() ||
    process.env.SA_BACKFILL_RPC_URL?.trim() ||
    process.env.SA_RPC_HTTP_URL?.trim() ||
    process.env.QUICKNODE_HTTP_URL?.trim() ||
    ''
  );
}

async function loadQnJsonRpc(): Promise<SaQnJsonRpcMod> {
  // @ts-expect-error ESM scripts-tmp/*.mjs
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
  const timeoutMs = envNum('SA_SIGSEED_HTTP_TIMEOUT_MS', 15_000);
  const j = await jr.jsonRpcWithQnLedger(poolPg, {
    rpcUrl,
    componentId: 'sigseed_worker',
    method,
    params,
    timeoutMs,
  });
  if (j.error) {
    const er = j.error as { code?: string; message?: string };
    if (er.code === 'QN_GLOBAL_DAY_CAP') {
      throw Object.assign(new Error('QN_GLOBAL_DAY_CAP'), er);
    }
    throw new Error(er.message || String(j.error));
  }
  return j.result;
}

async function sigseedCreditsUsed(client: pg.PoolClient): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE((by_component->>'sigseed_worker')::bigint, 0)::text AS u
     FROM sa_qn_global_daily WHERE usage_date = (timezone('UTC', now()))::date`,
  );
  if (res.rows.length === 0) return 0;
  const raw = res.rows[0]?.u;
  const n = typeof raw === 'string' ? Number(raw) : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let fromDex: number | null = null;
  for (const a of argv) {
    if (a.startsWith('--from-dex=')) {
      const n = Number(a.split('=')[1]);
      if (Number.isFinite(n) && n > 0) fromDex = Math.floor(n);
    }
  }
  const dryRun = argv.includes('--dry-run');
  const enqueueMode = argv.includes('--enqueue');
  return { fromDex, dryRun, enqueueMode };
}

async function countEnqueuedToday(client: pg.PoolClient): Promise<number> {
  const res = await client.query(
    `SELECT COUNT(*)::int AS c FROM signatures_seed_queue
     WHERE enqueued_at >= date_trunc('day', timezone('UTC', now()))`,
  );
  return Number(res.rows[0]?.c) || 0;
}

async function enqueueFromDex(
  client: pg.PoolClient,
  limit: number,
  swapsCeiling: number,
  dryRun: boolean,
): Promise<number> {
  const maxPerDay = envNum('SA_SIGSEED_ENQUEUE_MAX_PER_DAY', 400);
  const today = await countEnqueuedToday(client);
  const room = Math.max(0, maxPerDay - today);
  const take = Math.min(limit, room);
  if (take <= 0) return 0;

  if (dryRun) {
    const peek = await client.query(
      `WITH candidates AS (
         SELECT DISTINCT base_mint FROM (
           SELECT base_mint FROM raydium_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
           UNION SELECT base_mint FROM meteora_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
           UNION SELECT base_mint FROM orca_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
           UNION SELECT base_mint FROM moonshot_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
           UNION SELECT base_mint FROM pumpswap_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
         ) x
       )
       SELECT c.base_mint FROM candidates c
       WHERE NOT EXISTS (SELECT 1 FROM signatures_seed_queue q WHERE q.mint = c.base_mint)
       AND (SELECT COUNT(*) FROM swaps s WHERE s.base_mint = c.base_mint) < $1
       LIMIT $2`,
      [swapsCeiling, take],
    );
    console.log(
      JSON.stringify({ ok: true, component: 'sigseed-enqueue', dryRun: true, wouldEnqueue: peek.rows.length }, null, 2),
    );
    return peek.rows.length;
  }

  const ins = await client.query(
    `WITH candidates AS (
       SELECT DISTINCT base_mint FROM (
         SELECT base_mint FROM raydium_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
         UNION SELECT base_mint FROM meteora_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
         UNION SELECT base_mint FROM orca_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
         UNION SELECT base_mint FROM moonshot_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
         UNION SELECT base_mint FROM pumpswap_pair_snapshots WHERE ts > timezone('UTC', now()) - interval '8 days'
       ) x
     ),
     picked AS (
       SELECT c.base_mint AS mint,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM pumpswap_pair_snapshots p
             WHERE p.base_mint = c.base_mint AND p.ts > timezone('UTC', now()) - interval '8 days'
           ) THEN 90 ELSE 55 END AS priority
       FROM candidates c
       WHERE NOT EXISTS (SELECT 1 FROM signatures_seed_queue q WHERE q.mint = c.base_mint)
       AND (SELECT COUNT(*) FROM swaps s WHERE s.base_mint = c.base_mint) < $1
       LIMIT $2
     )
     INSERT INTO signatures_seed_queue (mint, priority, status)
     SELECT mint, priority, 'pending' FROM picked
     ON CONFLICT (mint) DO NOTHING`,
    [swapsCeiling, take],
  );
  return ins.rowCount ?? 0;
}

async function pickMintBatch(client: pg.PoolClient, batch: number): Promise<string[]> {
  const res = await client.query(
    `SELECT q.mint
     FROM signatures_seed_queue q
     WHERE q.status IN ('pending', 'done')
     ORDER BY q.priority DESC, q.last_run_at ASC NULLS FIRST
     LIMIT $1`,
    [batch],
  );
  return res.rows.map((r: { mint: string }) => r.mint);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { fromDex: fromDexArg, dryRun, enqueueMode } = parseArgs();
  const enqueueLimit: number | null =
    enqueueMode || fromDexArg !== null ? (fromDexArg ?? envNum('SA_SIGSEED_ENQUEUE_BATCH', 300)) : null;
  const databaseUrl = process.env.DATABASE_URL || process.env.SA_PG_DSN;
  if (!databaseUrl) {
    console.error('[fatal] DATABASE_URL or SA_PG_DSN required');
    process.exit(1);
  }

  // @ts-expect-error ESM budget lib
  const budgetMod = await import('../../scripts-tmp/sa-qn-global-budget-lib.mjs');
  budgetMod.logOperationalBudgetWarnings(process.env, { component: 'sigseed' });

  const poolPg = new Pool({ connectionString: databaseUrl });

  if (enqueueLimit !== null) {
    if (process.env.SA_SIGSEED_ENQUEUE_ENABLED !== '1') {
      console.log(
        JSON.stringify({
          ok: true,
          component: 'sigseed-enqueue',
          skipped: true,
          reason: 'set SA_SIGSEED_ENQUEUE_ENABLED=1 to enqueue',
        }),
      );
      await poolPg.end();
      await pgSqlClient.end({ timeout: 5 }).catch(() => {});
      return;
    }

    const swapsCeiling = envNum('SA_SIGSEED_SWAPS_CEILING', 120);
    const client = await poolPg.connect();
    try {
      const n = await enqueueFromDex(client, enqueueLimit, swapsCeiling, dryRun);
      console.log(JSON.stringify({ ok: true, component: 'sigseed-enqueue', enqueued: n, dryRun }, null, 2));
    } finally {
      client.release();
      await poolPg.end();
      await pgSqlClient.end({ timeout: 5 }).catch(() => {});
    }
    return;
  }

  if (process.env.SA_SIGSEED_ENABLED !== '1') {
    console.log(
      JSON.stringify({
        ok: true,
        component: 'sigseed-run',
        skipped: true,
        reason: 'set SA_SIGSEED_ENABLED=1 to run worker',
      }),
    );
    await poolPg.end();
    await pgSqlClient.end({ timeout: 5 }).catch(() => {});
    return;
  }

  const rpcUrl = pickRpcUrl();
  if (!rpcUrl) {
    console.error('[fatal] SA_SIGSEED_RPC_URL / QUICKNODE_HTTP_URL / SA_RPC_HTTP_URL required');
    process.exit(1);
  }

  const jr = await loadQnJsonRpc();
  const maxMints = envNum('SA_SIGSEED_MAX_MINTS_PER_RUN', 25);
  const sigPagesMax = envNum('SA_SIGSEED_SIG_PAGES_MAX', 2);
  const maxTx = envNum('SA_SIGSEED_MAX_TX_PER_MINT', 20);
  const rpcSleep = envNum('SA_SIGSEED_RPC_SLEEP_MS', 250);
  const pumpProgram = envStr('SA_PARSER_PROGRAM_ID', PUMP_FUN_PROGRAM_ID);
  const solUsd = envNum('SA_SOL_USD_FALLBACK', 150);
  /** 0 = только глобальный ledger (не суммировать в sa-qn-budget-check); мягкий потолок компонента выкл. */
  const maxComponentCredits = (() => {
    const raw = process.env.SA_SIGSEED_MAX_CREDITS_PER_DAY;
    if (raw === undefined || raw === '') return 120_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  })();

  const lockClient = await poolPg.connect();
  let swapsInserted = 0;
  let txFetched = 0;

  try {
    const lk = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY]);
    if (!lk.rows[0]?.ok) {
      console.log(
        JSON.stringify({
          ok: true,
          component: 'sigseed-run',
          skipped: true,
          reason: 'another sigseed run holds advisory lock',
        }),
      );
      return;
    }

    try {
      const used = await sigseedCreditsUsed(lockClient);
      if (maxComponentCredits > 0 && used >= maxComponentCredits) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              component: 'sigseed-run',
              skipped: true,
              reason: 'SA_SIGSEED_MAX_CREDITS_PER_DAY reached',
              sigseedCreditsUsed: used,
              cap: maxComponentCredits,
            },
            null,
            2,
          ),
        );
        return;
      }

      const mints = await pickMintBatch(lockClient, maxMints);
      if (mints.length === 0) {
        console.log(
          JSON.stringify({
            ok: true,
            component: 'sigseed-run',
            warning: 'queue empty — run sigseed:enqueue -- --from-dex=N',
            mints: 0,
          }),
          null,
          2,
        );
        return;
      }

      for (const mint of mints) {
        const usedNow = await sigseedCreditsUsed(lockClient);
        if (maxComponentCredits > 0 && usedNow >= maxComponentCredits) {
          console.log(
            JSON.stringify({
              ok: false,
              component: 'sigseed-run',
              code: 'SIGSEED_COMPONENT_DAY_CAP',
              partial: { swapsInserted, txFetched },
            }),
            null,
            2,
          );
          break;
        }

        await lockClient.query(
          `UPDATE signatures_seed_queue SET status = 'running', error_message = NULL WHERE mint = $1`,
          [mint],
        );

        let before: string | undefined;
        let txForMint = 0;

        try {
          for (let page = 0; page < sigPagesMax; page += 1) {
            if (txForMint >= maxTx) break;
            const opts: { limit: number; before?: string } = { limit: 100 };
            if (before) opts.before = before;

            const sigChunk = (await rpcJsonRpc(poolPg, jr, rpcUrl, 'getSignaturesForAddress', [
              mint,
              opts,
            ])) as Array<{ signature?: string; err?: unknown }> | null;

            await sleep(rpcSleep);

            if (!Array.isArray(sigChunk) || sigChunk.length === 0) break;

            for (const row of sigChunk) {
              if (txForMint >= maxTx) break;
              const sig = row.signature;
              if (!sig || row.err) continue;

              const txJson = (await rpcJsonRpc(poolPg, jr, rpcUrl, 'getTransaction', [
                sig,
                { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
              ])) as TxJsonParsed | null;

              txForMint += 1;
              txFetched += 1;
              await sleep(rpcSleep);

              if (!txJson || txJson.meta?.err != null) continue;

              const swaps = decodePumpfunSwap(txJson, pumpProgram, solUsd).map((s) => ({
                ...s,
                source: 'sigseed',
              }));

              if (swaps.length > 0) {
                const ins = await insertSwaps(swaps);
                swapsInserted += ins;
                await touchTokensAndWallets(swaps);
              }
            }

            before = sigChunk[sigChunk.length - 1]?.signature;
            if (!before || sigChunk.length < 100) break;
          }

          await lockClient.query(
            `UPDATE signatures_seed_queue
             SET status = 'done', last_run_at = now(), runs_count = runs_count + 1, sig_cursor = $2
             WHERE mint = $1`,
            [mint, before ?? null],
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code) : '';
          await lockClient.query(
            `UPDATE signatures_seed_queue SET status = 'error', error_message = $2, last_run_at = now() WHERE mint = $1`,
            [mint, msg.slice(0, 2000)],
          );
          if (code === 'QN_GLOBAL_DAY_CAP') {
            console.log(
              JSON.stringify({
                ok: false,
                component: 'sigseed-run',
                code: 'QN_GLOBAL_DAY_CAP',
                partial: { swapsInserted, txFetched },
              }),
              null,
              2,
            );
            break;
          }
        }
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            component: 'sigseed-run',
            mints: mints.length,
            txFetched,
            swapsInserted,
          },
          null,
          2,
        ),
      );
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
    await poolPg.end();
    await pgSqlClient.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
