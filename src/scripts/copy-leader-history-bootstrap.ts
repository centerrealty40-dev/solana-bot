/**
 * Backfill `leaderHistory` in a copy-trader state file from the leader's
 * on-chain past.
 *
 * The selective copy gate requires N prior closed round trips per mint before
 * it will copy anything. Without a backfill a fresh instance would sit idle for
 * days while it learns the leader from live polling; this replays his recent
 * history once so the gate is useful from the first tick.
 *
 *   npm run copy-trader:bootstrap-history -- --days 30
 *
 * Read-only against the chain. Only the `leaderHistory` key of the state file
 * is rewritten; positions, pending legs, and the leader ledger are untouched.
 */
import 'dotenv/config';
import path from 'node:path';
import {
  emptyCopyTraderState,
  readCopyTraderState,
  writeCopyTraderState,
  type LeaderMintHistory,
} from '../copytrader/state.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

/** Session return is clamped the same way the live tracker clamps it. */
const MAX_SESSION_PCT = 300;
const MIN_SESSION_PCT = -100;
/** Leader counts as flat once under this fraction of the session's peak size. */
const FLAT_DUST_FRACTION = 0.01;

type Leg = {
  ts: number;
  mint: string;
  side: 'buy' | 'sell';
  usd: number;
  tokens: number;
};

type HeliusTx = {
  timestamp?: number;
  slot?: number;
  signature?: string;
  type?: string;
  fee?: number;
  feePayer?: string;
  transactionError?: unknown;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: Array<{
      userAccount?: string;
      mint?: string;
      rawTokenAmount?: { tokenAmount?: string; decimals?: number };
    }>;
  }>;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function heliusApiKey(): string {
  const direct = process.env.HELIUS_API_KEY?.trim();
  if (direct) return direct;
  const url = process.env.HELIUS_RPC_URL?.trim();
  if (url) {
    try {
      const key = new URL(url).searchParams.get('api-key');
      if (key) return key;
    } catch {
      /* fall through */
    }
  }
  throw new Error('need HELIUS_API_KEY or HELIUS_RPC_URL with api-key');
}

async function getJson(url: string, tries = 6): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(700 * (i + 1));
    }
  }
  throw lastErr ?? new Error('request failed');
}

/** Hourly SOL/USD closes so a leg is priced near its actual trade time. */
async function loadSolUsdSeries(fromTs: number, toTs: number): Promise<Array<{ ts: number; close: number }>> {
  const out: Array<{ ts: number; close: number }> = [];
  let cursor = fromTs * 1000;
  const end = toTs * 1000;
  while (cursor < end) {
    const u = new URL('https://api.binance.com/api/v3/klines');
    u.searchParams.set('symbol', 'SOLUSDT');
    u.searchParams.set('interval', '1h');
    u.searchParams.set('startTime', String(cursor));
    u.searchParams.set('limit', '1000');
    const rows = (await getJson(u.toString())) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows as Array<[number, string, string, string, string]>) {
      out.push({ ts: Math.floor(r[0] / 1000), close: Number(r[4]) });
    }
    const last = rows[rows.length - 1] as [number];
    cursor = last[0] + 3_600_000;
    if (rows.length < 1000) break;
    await sleep(120);
  }
  return out;
}

function solUsdAt(series: Array<{ ts: number; close: number }>, ts: number): number {
  if (series.length === 0) return 0;
  if (ts <= series[0]!.ts) return series[0]!.close;
  let lo = 0;
  let hi = series.length - 1;
  if (ts >= series[hi]!.ts) return series[hi]!.close;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.ts <= ts) lo = mid;
    else hi = mid;
  }
  return series[lo]!.close;
}

async function fetchLeaderTxs(wallet: string, apiKey: string, cutoffTs: number): Promise<HeliusTx[]> {
  const out: HeliusTx[] = [];
  let before: string | undefined;
  for (let page = 0; page < 600; page++) {
    const u = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
    u.searchParams.set('api-key', apiKey);
    u.searchParams.set('limit', '100');
    if (before) u.searchParams.set('before', before);
    const rows = (await getJson(u.toString())) as HeliusTx[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    before = rows[rows.length - 1]?.signature;
    const oldest = rows[rows.length - 1]?.timestamp ?? 0;
    process.stderr.write(`\rpages=${page + 1} txs=${out.length} oldest=${new Date(oldest * 1000).toISOString().slice(0, 16)}`);
    if (!before || (oldest && oldest < cutoffTs)) break;
    if (rows.length < 100) break;
    await sleep(150);
  }
  process.stderr.write('\n');
  return out;
}

function flattenLegs(
  txs: HeliusTx[],
  wallet: string,
  solSeries: Array<{ ts: number; close: number }>,
): Leg[] {
  const legs: Leg[] = [];
  for (const tx of txs) {
    if (tx.type !== 'SWAP' || tx.transactionError) continue;
    const ts = tx.timestamp ?? 0;
    if (!ts) continue;

    let sol = 0;
    let stable = 0;
    const assets = new Map<string, number>();
    for (const ad of tx.accountData ?? []) {
      if (ad.account === wallet) sol += (ad.nativeBalanceChange ?? 0) / 1e9;
      for (const tb of ad.tokenBalanceChanges ?? []) {
        if (tb.userAccount !== wallet || !tb.mint) continue;
        const dec = tb.rawTokenAmount?.decimals ?? 0;
        const amt = Number(tb.rawTokenAmount?.tokenAmount ?? 0) / 10 ** dec;
        if (!Number.isFinite(amt) || amt === 0) continue;
        if (tb.mint === SOL_MINT) sol += amt;
        else if (STABLE_MINTS.has(tb.mint)) stable += amt;
        else assets.set(tb.mint, (assets.get(tb.mint) ?? 0) + amt);
      }
    }

    const entries = [...assets.entries()].filter(([, v]) => Math.abs(v) > 1e-12);
    if (entries.length !== 1) continue;
    const [mint, tokens] = entries[0]!;

    const feeSol = (tx.feePayer === wallet ? (tx.fee ?? 0) : 0) / 1e9;
    const solLeg = sol + (tokens > 0 ? feeSol : -feeSol);
    const usd = Math.abs(solLeg) * solUsdAt(solSeries, ts) + Math.abs(stable);
    if (!Number.isFinite(usd) || usd <= 0) continue;

    legs.push({ ts, mint, side: tokens > 0 ? 'buy' : 'sell', usd, tokens: Math.abs(tokens) });
  }
  legs.sort((a, b) => a.ts - b.ts);
  return legs;
}

function buildHistory(legs: Leg[]): Record<string, LeaderMintHistory> {
  const byMint = new Map<string, Leg[]>();
  for (const leg of legs) {
    const arr = byMint.get(leg.mint);
    if (arr) arr.push(leg);
    else byMint.set(leg.mint, [leg]);
  }

  const history: Record<string, LeaderMintHistory> = {};
  for (const [mint, mintLegs] of byMint) {
    const row: LeaderMintHistory = { sessions: 0, wins: 0, sumPct: 0 };
    let balance = 0;
    let peakBalance = 0;
    let cost = 0;
    let proceeds = 0;
    let startTs = 0;

    for (const leg of mintLegs) {
      if (leg.side === 'buy') {
        if (balance <= 0) startTs = leg.ts * 1000;
        balance += leg.tokens;
        peakBalance = Math.max(peakBalance, balance);
        cost += leg.usd;
        continue;
      }

      balance = Math.max(0, balance - leg.tokens);
      proceeds += leg.usd;
      if (balance > peakBalance * FLAT_DUST_FRACTION) continue;

      if (cost > 0) {
        const pct = Math.max(MIN_SESSION_PCT, Math.min(MAX_SESSION_PCT, (proceeds / cost - 1) * 100));
        row.sessions += 1;
        row.sumPct += pct;
        if (pct > 0) row.wins += 1;
        row.lastClosedTs = leg.ts * 1000;
      }
      balance = 0;
      peakBalance = 0;
      cost = 0;
      proceeds = 0;
      startTs = 0;
    }

    // Leader is still holding — hand the open session to the live tracker.
    if (balance > 0 && cost > 0) {
      row.openCostUsd = cost;
      if (proceeds > 0) row.openProceedsUsd = proceeds;
      if (startTs > 0) row.openStartTs = startTs;
    }

    if (row.sessions > 0 || row.openCostUsd != null) history[mint] = row;
  }
  return history;
}

async function main(): Promise<void> {
  const wallet = (arg('wallet') ?? process.env.COPY_TRADER_TARGET_WALLET ?? '').trim();
  if (!wallet) throw new Error('need --wallet or COPY_TRADER_TARGET_WALLET');

  const statePath = (
    arg('state') ??
    process.env.COPY_TRADER_STATE_PATH ??
    path.join('data', 'copytrader', 'state.json')
  ).trim();
  const days = Number(arg('days') ?? 30);
  if (!Number.isFinite(days) || days <= 0 || days > 120) throw new Error('--days must be 1..120');
  const dryRun = hasFlag('dry-run');

  const cutoffTs = Math.floor(Date.now() / 1000) - days * 86_400;
  console.log(`[bootstrap] leader=${wallet} days=${days} state=${statePath}${dryRun ? ' (dry-run)' : ''}`);

  const txs = await fetchLeaderTxs(wallet, heliusApiKey(), cutoffTs);
  const inWindow = txs.filter((t) => (t.timestamp ?? 0) >= cutoffTs);
  if (inWindow.length === 0) throw new Error('no transactions in window');

  const tsMin = Math.min(...inWindow.map((t) => t.timestamp ?? 0));
  const tsMax = Math.max(...inWindow.map((t) => t.timestamp ?? 0));
  const solSeries = await loadSolUsdSeries(tsMin - 7200, tsMax + 3600);

  const legs = flattenLegs(inWindow, wallet, solSeries);
  const history = buildHistory(legs);

  const mints = Object.keys(history);
  const qualifying = mints.filter((m) => (history[m]?.sessions ?? 0) >= 3);
  const withEdge = qualifying.filter((m) => {
    const row = history[m]!;
    return row.sumPct / row.sessions > 5;
  });

  console.log(
    `[bootstrap] txs=${inWindow.length} legs=${legs.length} mints=${mints.length} ` +
      `sessions>=3: ${qualifying.length} · of those avg>+5%: ${withEdge.length}`,
  );

  if (dryRun) {
    console.log('[bootstrap] dry-run — state not written');
    return;
  }

  const state = readCopyTraderState(statePath);
  const base = Object.keys(state.positions).length > 0 || state.lastSignature ? state : emptyCopyTraderState();
  base.leaderHistory = history;
  writeCopyTraderState(statePath, base);
  console.log(`[bootstrap] wrote leaderHistory for ${mints.length} mints to ${statePath}`);
}

main().catch((err) => {
  console.error('[bootstrap] failed', (err as Error).message);
  process.exit(1);
});
