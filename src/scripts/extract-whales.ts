import { promises as fs } from 'node:fs';
import { child } from '../core/logger.js';
import type { SwapEvent } from '../collectors/helius-discovery.js';
import type { PumpedToken } from '../collectors/dex-pumped.js';
import type { LongformWinner } from '../collectors/dex-longform.js';
import { isExcludedAddress } from '../core/known-addresses.js';

const log = child('extract-whales');

/**
 * Extract "raw whales" — wallets that put REAL money into pumped/winner tokens —
 * from a cached pump or longform discovery file. No Helius credits spent: this
 * processes data we already paid for offline.
 *
 * Why this exists:
 *   Our pump-retro and longform alpha filters are designed to find wallets that
 *   appear EARLY in MULTIPLE winners (cross-token signal). That's the cleanest
 *   alpha but it's a very tight filter — most pumps don't share early buyers,
 *   so the filter often drops to 0 even on legitimate data.
 *
 *   For seeding the H8 rotation graph, we don't need cross-token alpha — we
 *   just need ANCHOR WALLETS: people who deployed real SOL into something that
 *   subsequently won. Even a single big buy on a 5x token is meaningful.
 *
 *   The rotation discovery then traces these anchors' outgoing transfers to
 *   find their hidden side wallets — the actual non-obvious alpha.
 *
 * Usage:
 *   npm run whales:extract -- --in cache/pump.json --out seeds/whales.txt
 *   npm run whales:extract -- --in cache/longform.json --out seeds/whales.txt --top 200
 */

interface WalletWhaleStats {
  wallet: string;
  totalSol: number;
  totalUsd: number;
  distinctTokens: number;
  topBuys: Array<{ mint: string; symbol: string; sol: number; ts: number }>;
}

function parseArgs(): { inPath: string; outPath: string; top: number; minSol: number; format: 'txt' | 'csv' } {
  const args = process.argv.slice(2);
  let inPath = '';
  let outPath = '';
  let top = 100;
  let minSol = 1;
  let format: 'txt' | 'csv' = 'txt';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) {
        console.error(`missing value for ${a}`);
        process.exit(1);
      }
      return v;
    };
    if (a === '--in') inPath = next();
    else if (a === '--out') outPath = next();
    else if (a === '--top') top = Number(next());
    else if (a === '--min-sol') minSol = Number(next());
    else if (a === '--csv') format = 'csv';
  }
  if (!inPath || !outPath) {
    console.error(
      'Usage: npm run whales:extract -- --in cache/pump.json --out seeds/whales.txt [--top 100] [--min-sol 1] [--csv]',
    );
    process.exit(1);
  }
  return { inPath, outPath, top, minSol, format };
}

/**
 * Detect the cache shape (pump vs longform) and return a unified per-token
 * symbol map plus the events dict.
 */
function unifyCache(
  raw: unknown,
): { symbolByMint: Map<string, string>; perTokenEvents: Record<string, SwapEvent[]> } {
  const obj = raw as Record<string, unknown>;
  const symbolByMint = new Map<string, string>();

  if (Array.isArray(obj.pumped)) {
    const pumped = obj.pumped as PumpedToken[];
    for (const p of pumped) symbolByMint.set(p.mint, p.symbol ?? p.mint.slice(0, 6));
    return {
      symbolByMint,
      perTokenEvents: obj.perTokenEvents as Record<string, SwapEvent[]>,
    };
  }
  if (Array.isArray(obj.winners)) {
    const winners = obj.winners as LongformWinner[];
    for (const w of winners) symbolByMint.set(w.mint, w.symbol ?? w.mint.slice(0, 6));
    return {
      symbolByMint,
      perTokenEvents: obj.perTokenEvents as Record<string, SwapEvent[]>,
    };
  }
  throw new Error('cache file is neither a pump cache (.pumped[]) nor a longform cache (.winners[])');
}

/**
 * Aggregate per-wallet statistics across all token events. We only count BUYS
 * (the relevant signal — sellers are usually team/snipers exiting).
 */
function aggregateWhales(
  perTokenEvents: Record<string, SwapEvent[]>,
  symbolByMint: Map<string, string>,
): WalletWhaleStats[] {
  const byWallet = new Map<string, WalletWhaleStats>();

  for (const [mint, events] of Object.entries(perTokenEvents)) {
    const symbol = symbolByMint.get(mint) ?? mint.slice(0, 6);
    for (const e of events) {
      if (e.side !== 'buy') continue;
      if (e.solValue <= 0) continue; // can't size unpriced trades
      const w = e.wallet;
      if (isExcludedAddress(w)) continue;
      let stats = byWallet.get(w);
      if (!stats) {
        stats = {
          wallet: w,
          totalSol: 0,
          totalUsd: 0,
          distinctTokens: 0,
          topBuys: [],
        };
        byWallet.set(w, stats);
      }
      stats.totalSol += e.solValue;
      stats.totalUsd += e.amountUsd;
      stats.topBuys.push({ mint, symbol, sol: e.solValue, ts: e.ts });
    }
  }

  // Compute distinctTokens after the fact and trim topBuys to the 5 largest
  for (const stats of byWallet.values()) {
    stats.distinctTokens = new Set(stats.topBuys.map((b) => b.mint)).size;
    stats.topBuys.sort((a, b) => b.sol - a.sol);
    stats.topBuys = stats.topBuys.slice(0, 5);
  }

  return Array.from(byWallet.values()).sort((a, b) => b.totalSol - a.totalSol);
}

async function main(): Promise<void> {
  const { inPath, outPath, top, minSol, format } = parseArgs();

  log.info({ inPath, outPath, top, minSol }, 'extracting whales from cache');
  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));
  const { symbolByMint, perTokenEvents } = unifyCache(raw);

  const totalEvents = Object.values(perTokenEvents).reduce((s, arr) => s + arr.length, 0);
  log.info(
    { tokens: Object.keys(perTokenEvents).length, totalEvents },
    'cache loaded',
  );

  let whales = aggregateWhales(perTokenEvents, symbolByMint);
  log.info({ totalWallets: whales.length }, 'aggregation done');

  // Filter by min SOL
  const beforeMin = whales.length;
  whales = whales.filter((w) => w.totalSol >= minSol);
  if (whales.length < beforeMin) {
    log.info({ before: beforeMin, after: whales.length, minSol }, 'min-sol filter applied');
  }

  // Cap to top-N
  whales = whales.slice(0, top);

  // Print preview
  console.log(`\nTop ${Math.min(30, whales.length)} whales by SOL spent on cached tokens:`);
  console.log(
    'Wallet                                              TotalSOL  Tokens  TopBuys',
  );
  console.log(
    '--------------------------------------------------  --------  ------  ----------------------------------',
  );
  for (const w of whales.slice(0, 30)) {
    const wallet = w.wallet.padEnd(50);
    const sol = w.totalSol.toFixed(1).padStart(8);
    const tokens = String(w.distinctTokens).padStart(6);
    const top3 = w.topBuys
      .slice(0, 3)
      .map((b) => `${b.symbol}(${b.sol.toFixed(1)})`)
      .join(', ');
    console.log(`${wallet}  ${sol}  ${tokens}  ${top3}`);
  }
  console.log('');

  // Write output
  const outDir = outPath.replace(/[/\\][^/\\]+$/, '');
  if (outDir && outDir !== outPath) {
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
  }
  if (format === 'csv') {
    const lines = ['wallet,total_sol,total_usd,distinct_tokens'];
    for (const w of whales) {
      lines.push(
        `${w.wallet},${w.totalSol.toFixed(2)},${w.totalUsd.toFixed(2)},${w.distinctTokens}`,
      );
    }
    await fs.writeFile(outPath, lines.join('\n') + '\n');
  } else {
    const lines = whales.map((w) => w.wallet);
    await fs.writeFile(outPath, lines.join('\n') + '\n');
  }
  log.info({ count: whales.length, path: outPath }, 'whales written');
  log.info(
    `next: ROT_SEED_FILE=${outPath} ROT_DRY_RUN=1 ROT_DUMP=cache/rot.json npm run watchlist:seed:rotation`,
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'extract-whales failed');
  process.exit(1);
});
