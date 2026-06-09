/**
 * Backtest follow-bot exits on hnu5 closed PumpSwap round-trips (PG swaps + minute snapshots).
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *   npx tsx scripts-tmp/follow-hnu5-exit-backtest.ts --days 14
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { resolveSolanaRpcUrl } from '../src/core/rpc/resolve-solana-rpc-url.js';
import { fetchParsedTransaction, rpcCall, type SignatureRow } from '../src/copytrader/rpc.js';
import { decodeAllowlistedDexSwapForWallet } from '../src/parser/allowlisted-dex-swap.js';
import type { TxJsonParsed } from '../src/parser/rpc-http.js';
import { getSolUsd } from '../src/papertrader/pricing.js';
import { HNU5_TARGET_WALLET } from '../src/pumpswap-combo-follow/config.js';
import {
  defaultSimParams,
  simulateFollowExits,
  type FollowSimEvent,
  type FollowSimParams,
  type FollowSimResult,
} from '../src/pumpswap-combo-follow/follow-exit-sim.js';
import { parseFollowSlMode, type FollowSlMode } from '../src/pumpswap-combo-follow/exit-policy.js';

const WALLET = process.env.FOLLOW_BT_WALLET?.trim() || HNU5_TARGET_WALLET;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!.trim();
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type SwapRow = {
  block_time: Date | string;
  base_mint: string;
  side: string;
  price_usd: number;
  amount_usd: number;
  base_amount_raw: string | bigint;
};

async function loadLeaderSwapsFromRpc(days: number, maxParse: number): Promise<SwapRow[]> {
  const rpcUrl = resolveSolanaRpcUrl();
  if (!rpcUrl) throw new Error('no_rpc_url');

  const sinceSec = Math.floor(Date.now() / 1000) - days * 86_400;
  const sigs: SignatureRow[] = [];
  let before: string | undefined;
  for (let page = 0; page < 80; page++) {
    const opts: { limit: number; before?: string } = { limit: 100 };
    if (before) opts.before = before;
    const chunk = await rpcCall<SignatureRow[]>(rpcUrl, 'getSignaturesForAddress', [WALLET, opts], 6);
    if (!chunk?.length) break;
    let stop = false;
    for (const row of chunk) {
      if (row.blockTime && row.blockTime < sinceSec) {
        stop = true;
        break;
      }
      if (!row.err) sigs.push(row);
    }
    if (stop) break;
    before = chunk.at(-1)?.signature;
    if (chunk.length < 100) break;
    await sleep(120);
  }

  sigs.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  let toParse = sigs;
  if (maxParse > 0 && sigs.length > maxParse) {
    const step = Math.ceil(sigs.length / maxParse);
    toParse = sigs.filter((_, i) => i % step === 0 || i >= sigs.length - Math.floor(maxParse * 0.35));
    toParse = [...new Map(toParse.map((s) => [s.signature, s])).values()].sort(
      (a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0),
    );
  }

  console.error(`[follow-bt] rpc sigs=${sigs.length} parsing=${toParse.length}`);
  const solUsd = getSolUsd();
  const rows: SwapRow[] = [];
  for (let i = 0; i < toParse.length; i++) {
    if (i > 0 && i % 40 === 0) console.error(`[follow-bt] rpc parse ${i}/${toParse.length}`);
    const row = toParse[i]!;
    const raw = await fetchParsedTransaction(rpcUrl, row.signature);
    if (!raw) continue;
    const swap = decodeAllowlistedDexSwapForWallet(raw as TxJsonParsed, WALLET, solUsd);
    if (!swap || swap.dex !== 'pumpswap' || swap.priceUsd <= 0 || swap.amountUsd <= 0) continue;
    rows.push({
      block_time: new Date((row.blockTime ?? 0) * 1000),
      base_mint: swap.baseMint,
      side: swap.side,
      price_usd: swap.priceUsd,
      amount_usd: swap.amountUsd,
      base_amount_raw: swap.baseAmountRaw,
    });
    await sleep(180);
  }
  return rows;
}

async function loadLeaderSwaps(days: number, source: string, maxParse: number): Promise<SwapRow[]> {
  if (source === 'rpc') return loadLeaderSwapsFromRpc(days, maxParse);
  const pg = await loadLeaderSwapsPg(days);
  if (pg.length >= 10) return pg;
  console.error('[follow-bt] pg sparse — falling back to rpc');
  return loadLeaderSwapsFromRpc(days, maxParse);
}

async function loadLeaderSwapsPg(days: number): Promise<SwapRow[]> {
  const walletEsc = sqlQuoteMint(WALLET);
  const raw = await db.execute(dsql.raw(`
    SELECT block_time, base_mint, side, price_usd, amount_usd, base_amount_raw
    FROM swaps
    WHERE wallet = ${walletEsc}
      AND dex = 'pumpswap'
      AND block_time >= now() - interval '${Math.max(1, days)} days'
      AND amount_usd > 0
      AND price_usd > 0
    ORDER BY block_time ASC
  `));
  return raw as unknown as SwapRow[];
}

async function loadSnapshots(mint: string, tMinMs: number, tMaxMs: number): Promise<{ tsMs: number[]; px: number[] } | null> {
  const mintEsc = sqlQuoteMint(mint);
  const fromSec = (tMinMs / 1000).toFixed(3);
  const toSec = (tMaxMs / 1000).toFixed(3);
  const raw = await db.execute(dsql.raw(`
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
           COALESCE(price_usd, 0)::float AS price_usd
    FROM pumpswap_pair_snapshots
    WHERE base_mint = ${mintEsc}
      AND ts >= to_timestamp(${fromSec}) AT TIME ZONE 'UTC'
      AND ts <= to_timestamp(${toSec}) AT TIME ZONE 'UTC'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts_ms ASC
  `));
  const rows = raw as unknown as Array<{ ts_ms: string | bigint; price_usd: number }>;
  if (!rows.length) return null;

  const tsMs: number[] = [];
  const px: number[] = [];
  let lastBucket = -1;
  for (const r of rows) {
    const ts = typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms);
    const bucket = Math.floor(ts / 60_000);
    if (bucket === lastBucket && px.length > 0) {
      px[px.length - 1] = r.price_usd;
    } else {
      tsMs.push(ts);
      px.push(r.price_usd);
      lastBucket = bucket;
    }
  }
  return tsMs.length ? { tsMs, px } : null;
}

function toEvents(rows: SwapRow[]): FollowSimEvent[] {
  const out: FollowSimEvent[] = [];
  for (const r of rows) {
    const side = String(r.side).toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;
    const ts =
      r.block_time instanceof Date
        ? r.block_time.getTime()
        : new Date(r.block_time).getTime();
    const baseRaw = BigInt(String(r.base_amount_raw));
    if (side === 'buy') {
      out.push({
        kind: 'leader_buy',
        ts,
        mint: r.base_mint,
        priceUsd: Number(r.price_usd),
        amountUsd: Number(r.amount_usd),
        baseRaw,
      });
    } else {
      out.push({
        kind: 'leader_sell',
        ts,
        mint: r.base_mint,
        priceUsd: Number(r.price_usd),
        baseRaw,
      });
    }
  }
  return out;
}

function labelParams(p: FollowSimParams): string {
  return [
    `legs=${p.maxBuyLegs}`,
    `sl=${p.slMode}`,
    `sl1=${p.slSingleLegPct}`,
    `slM=${p.slMultiLegPct}`,
    `pre=${p.slPreDcaPct}`,
  ].join(' ');
}

function runGrid(
  events: FollowSimEvent[],
  snapshotsByMint: Map<string, { tsMs: number[]; px: number[] }>,
  baseline: FollowSimParams,
): FollowSimResult[] {
  const results: FollowSimResult[] = [];
  const slModes: FollowSlMode[] = ['fixed', 'while_leader_holds_off', 'after_leader_sell'];
  const maxLegsGrid = [1, 2, 3];
  const slSingleGrid = [20, 25, 30, 35];
  const slMultiGrid = [22, 28, 33, 40];
  const slPreGrid = [35, 45, 55];

  for (const slMode of slModes) {
    for (const maxBuyLegs of maxLegsGrid) {
      for (const slSingleLegPct of slSingleGrid) {
        for (const slMultiLegPct of slMultiGrid) {
          for (const slPreDcaPct of slPreGrid) {
            const params: FollowSimParams = {
              ...baseline,
              slMode,
              maxBuyLegs,
              slSingleLegPct,
              slMultiLegPct,
              slPreDcaPct,
            };
            results.push(simulateFollowExits({ events, snapshotsByMint, params }));
          }
        }
      }
    }
  }

  return results;
}

async function main(): Promise<void> {
  const days = argNum('--days', 14);
  const topN = argNum('--top', 15);
  const maxParse = argNum('--max-parse', Number(process.env.FOLLOW_BT_MAX_PARSE ?? 350));
  const source = argStr('--source', 'auto');
  const quick = process.argv.includes('--quick');

  console.error(`[follow-bt] wallet=${WALLET} days=${days} source=${source}`);

  const rows = await loadLeaderSwaps(days, source === 'auto' ? 'pg' : source, maxParse);
  const events = toEvents(rows);
  console.error(`[follow-bt] pumpswap events=${events.length} uniqueMints=${new Set(events.map((e) => e.mint)).size}`);

  if (!events.length) {
    console.log(JSON.stringify({ error: 'no_swaps', wallet: WALLET, days }, null, 2));
    return;
  }

  const mints = [...new Set(events.map((e) => e.mint))];
  const tMin = events[0]!.ts - 60_000;
  const tMax = events.at(-1)!.ts + 86_400_000;
  const snapshotsByMint = new Map<string, { tsMs: number[]; px: number[] }>();

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i]!;
    if (i > 0 && i % 10 === 0) console.error(`[follow-bt] snapshots ${i}/${mints.length}`);
    const ser = await loadSnapshots(mint, tMin, tMax);
    if (ser) snapshotsByMint.set(mint, ser);
  }
  console.error(`[follow-bt] snapshots loaded for ${snapshotsByMint.size}/${mints.length} mints`);

  const baseline = defaultSimParams();

  const baselineFixed = simulateFollowExits({
    events,
    snapshotsByMint,
    params: { ...baseline, slMode: 'fixed' },
  });
  const baselineLeaderHold = simulateFollowExits({
    events,
    snapshotsByMint,
    params: { ...baseline, slMode: 'while_leader_holds_off' },
  });

  let grid: FollowSimResult[];
  if (quick) {
    grid = [
      baselineFixed,
      baselineLeaderHold,
      simulateFollowExits({
        events,
        snapshotsByMint,
        params: { ...baseline, slMode: 'while_leader_holds_off', maxBuyLegs: 3, slSingleLegPct: 30, slMultiLegPct: 33, slPreDcaPct: 45 },
      }),
      simulateFollowExits({
        events,
        snapshotsByMint,
        params: { ...baseline, slMode: 'while_leader_holds_off', maxBuyLegs: 2, slSingleLegPct: 25, slMultiLegPct: 28, slPreDcaPct: 40 },
      }),
    ];
  } else {
    grid = runGrid(events, snapshotsByMint, baseline);
  }

  grid.sort((a, b) => b.sumPnlUsd - a.sumPnlUsd);
  const leaderHoldGrid = grid
    .filter((r) => r.params.slMode === 'while_leader_holds_off')
    .sort((a, b) => b.sumPnlUsd - a.sumPnlUsd);

  const report = {
    meta: {
      wallet: WALLET,
      days,
      events: events.length,
      mints: mints.length,
      snapshotMints: snapshotsByMint.size,
      gridSize: grid.length,
      slModeDefault: parseFollowSlMode(undefined),
    },
    baseline: {
      fixed: summarize(baselineFixed),
      whileLeaderHoldsOff: summarize(baselineLeaderHold),
    },
    top: grid.slice(0, topN).map(summarize),
    topLeaderHold: leaderHoldGrid.slice(0, topN).map(summarize),
    deltaLeaderHoldVsFixed: {
      pnlUsd: +(baselineLeaderHold.sumPnlUsd - baselineFixed.sumPnlUsd).toFixed(2),
      stopLossAvoided: baselineFixed.stopLossCount - baselineLeaderHold.stopLossCount,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

function summarize(r: FollowSimResult) {
  return {
    label: labelParams(r.params),
    sumPnlUsd: r.sumPnlUsd,
    winRatePct: r.winRatePct,
    roundTrips: r.roundTrips.length,
    stopLoss: r.stopLossCount,
    ladder: r.ladderCount,
    openLeaderHolds: r.openLeaderHolds,
    slMode: r.params.slMode,
    maxBuyLegs: r.params.maxBuyLegs,
    slSingle: r.params.slSingleLegPct,
    slMulti: r.params.slMultiLegPct,
    slPreDca: r.params.slPreDcaPct,
  };
}

main().catch((e) => {
  console.error('[follow-bt] fatal', e);
  process.exit(1);
});
