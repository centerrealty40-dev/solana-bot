/**
 * paper2-diagnose-dip-recovery.ts — утилита репозитория (класс **A**, см. `DIAGNOSTIC_SCRIPTS.md`).
 *
 * Назначение: для одного mint вывести PG-агрегаты high/low по окнам (как в dip-discovery), `evaluateDip`
 * и `evaluateRecoveryVeto` (только чтение БД).
 *
 * Входы: argv[2] = mint; argv[3] = опционально `pumpswap`|`raydium`|… (по умолчанию pumpswap).
 * Env: как у paper-процесса — **`DATABASE_URL`** / dotenv; для паритета задайте те же **`PAPER_DIP_*`** и **`PAPER_DIP_RECOVERY_VETO_*`**.
 *
 * Пример: `npm run paper2:diagnose-dip-recovery -- <mint> pumpswap`
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateDip,
  evaluateRecoveryVeto,
  fetchDipContextMap,
} from '../src/papertrader/dip-detector.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

const TABLES: Record<string, string> = {
  pumpswap: 'pumpswap_pair_snapshots',
  raydium: 'raydium_pair_snapshots',
  orca: 'orca_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
};

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table name: ${ident}`);
  return ident;
}

async function main(): Promise<void> {
  const mint = process.argv[2]?.trim();
  if (!mint) {
    console.error('Usage: npm run paper2:diagnose-dip-recovery -- <mint> [pumpswap|raydium|...]');
    process.exit(1);
  }
  const srcKey = (process.argv[3]?.trim().toLowerCase() || 'pumpswap') as keyof typeof TABLES;
  const table = TABLES[srcKey];
  if (!table) {
    console.error(`Unknown source ${srcKey}; use: ${Object.keys(TABLES).join(', ')}`);
    process.exit(1);
  }

  const cfg = loadPaperTraderConfig();
  const t = quoteSqlIdent(table);
  const mintEsc = mint.replace(/'/g, "''");

  const raw = await db.execute(dsql.raw(`
    SELECT
      p.base_mint AS mint,
      COALESCE(tok.symbol, '?') AS symbol,
      COALESCE(tok.holder_count, 0)::int AS holder_count,
      EXTRACT(EPOCH FROM (now() - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
      p.ts,
      NULL::timestamptz AS launch_ts,
      EXTRACT(EPOCH FROM (p.ts - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS age_min,
      COALESCE(p.price_usd, 0)::float AS price_usd,
      COALESCE(p.liquidity_usd, 0)::float AS liquidity_usd,
      COALESCE(p.volume_5m, 0)::float AS volume_5m,
      COALESCE(p.buys_5m, 0)::int AS buys_5m,
      COALESCE(p.sells_5m, 0)::int AS sells_5m,
      COALESCE(p.market_cap_usd, p.fdv_usd, 0)::float AS market_cap_usd,
      p.pair_address::text AS pair_address,
      '${srcKey}'::text AS source
    FROM ${t} p
    LEFT JOIN tokens tok ON tok.mint = p.base_mint
    WHERE p.base_mint = '${mintEsc}'
    ORDER BY p.ts DESC
    LIMIT 1
  `));

  const rows = raw as unknown as SnapshotCandidateRow[];
  const snap = rows[0];
  if (!snap) {
    console.error(JSON.stringify({ ok: false, error: 'no_snapshot_row', mint, table: t }, null, 2));
    process.exit(2);
  }

  const dipMap = await fetchDipContextMap(cfg, [snap]);
  const dipEval = evaluateDip(cfg, snap, dipMap.get(snap.mint));
  const recovery =
    dipEval.reasons.length === 0
      ? evaluateRecoveryVeto(cfg, snap, dipMap.get(snap.mint), dipEval.dipLookbackUsedMin)
      : { reasons: [] as string[], bounces: {} as Record<number, number> };

  console.log(
    JSON.stringify(
      {
        ok: true,
        mint: snap.mint,
        symbol: snap.symbol,
        source: snap.source,
        snapshot_ts: snap.ts,
        price_usd: snap.price_usd,
        dip_eval: dipEval,
        recovery_veto: recovery,
        aggregation_windows_min: cfg.dipAggregationWindowsMin,
        recovery_veto_cfg: {
          enabled: cfg.dipRecoveryVetoEnabled,
          windows_min: cfg.dipRecoveryVetoWindowsMin,
          max_bounce_pct: cfg.dipRecoveryVetoMaxBouncePct,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
