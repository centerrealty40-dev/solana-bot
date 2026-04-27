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
  /** SOL accumulated across priced buys only (best-effort) */
  totalSol: number;
  /** USD accumulated across priced buys only (best-effort) */
  totalUsd: number;
  /** distinct cached tokens this wallet bought */
  distinctTokens: number;
  /** buys with sizing data (solValue > 0 OR amountUsd > 0) */
  pricedBuys: number;
  /** ALL buys (priced + unpriced); presence signal when sizing missing */
  totalBuys: number;
  /** composite ranking score */
  score: number;
  topBuys: Array<{ mint: string; symbol: string; sol: number; usd: number; ts: number }>;
}

interface ParsedArgs {
  inPath: string;
  outPath: string;
  top: number;
  minSol: number;
  minTokens: number;
  minBuys: number;
  solPrice: number;
  format: 'txt' | 'csv';
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let inPath = '';
  let outPath = '';
  let top = 100;
  let minSol = 0;
  let minTokens = 1;
  let minBuys = 1;
  let solPrice = 200;
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
    else if (a === '--min-tokens') minTokens = Number(next());
    else if (a === '--min-buys') minBuys = Number(next());
    else if (a === '--sol-price') solPrice = Number(next());
    else if (a === '--csv') format = 'csv';
  }
  if (!inPath || !outPath) {
    console.error(
      'Usage: npm run whales:extract -- --in cache/pump.json --out seeds/whales.txt\n' +
        '       [--top 100] [--min-sol 0] [--min-tokens 1] [--min-buys 1]\n' +
        '       [--sol-price 200] [--csv]\n\n' +
        '  --min-tokens/--min-buys are presence-based filters (work even when\n' +
        '  Jupiter pricing is missing for most cached events, which is common\n' +
        '  for fresh memecoins). --min-sol additionally filters wallets with\n' +
        '  enough sized buys.',
    );
    process.exit(1);
  }
  return { inPath, outPath, top, minSol, minTokens, minBuys, solPrice, format };
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
 *
 * Sizing is best-effort:
 *   - Use `e.solValue` if populated (new parser).
 *   - Else derive from `e.amountUsd` / solPrice if amountUsd > 0 (works for
 *     events priced via Jupiter even on older caches).
 *   - Else solValue=0, but the buy is STILL counted in totalBuys/distinctTokens
 *     as a presence signal — for fresh memecoins where pricing is missing,
 *     wallet appearance across multiple winners is itself meaningful.
 *
 * Composite score:
 *   distinctTokens * 30        ← multi-token presence is the strongest signal
 *   + log10(1+totalUsd) * 10   ← real-money sizing where available
 *   + log10(1+totalBuys) * 5   ← high-conviction wallets buy multiple times
 */
function aggregateWhales(
  perTokenEvents: Record<string, SwapEvent[]>,
  symbolByMint: Map<string, string>,
  solPrice: number,
): { whales: WalletWhaleStats[]; coverage: { totalBuys: number; pricedBuys: number } } {
  const byWallet = new Map<string, WalletWhaleStats>();
  let totalBuysSeen = 0;
  let pricedBuysSeen = 0;

  for (const [mint, events] of Object.entries(perTokenEvents)) {
    const symbol = symbolByMint.get(mint) ?? mint.slice(0, 6);
    for (const e of events) {
      if (e.side !== 'buy') continue;
      const w = e.wallet;
      if (isExcludedAddress(w)) continue;
      totalBuysSeen++;

      // Best-effort sizing
      let sol = typeof e.solValue === 'number' && e.solValue > 0 ? e.solValue : 0;
      let usd = typeof e.amountUsd === 'number' && e.amountUsd > 0 ? e.amountUsd : 0;
      if (sol === 0 && usd > 0 && solPrice > 0) {
        sol = usd / solPrice;
      }
      if (sol === 0 && usd === 0) {
        // unpriced — still count presence below, no sizing contribution
      } else {
        pricedBuysSeen++;
      }

      let stats = byWallet.get(w);
      if (!stats) {
        stats = {
          wallet: w,
          totalSol: 0,
          totalUsd: 0,
          distinctTokens: 0,
          pricedBuys: 0,
          totalBuys: 0,
          score: 0,
          topBuys: [],
        };
        byWallet.set(w, stats);
      }
      stats.totalSol += sol;
      stats.totalUsd += usd;
      stats.totalBuys += 1;
      if (sol > 0 || usd > 0) stats.pricedBuys += 1;
      stats.topBuys.push({ mint, symbol, sol, usd, ts: e.ts });
    }
  }

  for (const stats of byWallet.values()) {
    stats.distinctTokens = new Set(stats.topBuys.map((b) => b.mint)).size;
    // Composite scoring
    stats.score =
      stats.distinctTokens * 30 +
      Math.log10(1 + stats.totalUsd) * 10 +
      Math.log10(1 + stats.totalBuys) * 5;
    // Largest first; if no priced buys, fall back to chronological for sanity
    stats.topBuys.sort((a, b) => b.sol + b.usd / 1000 - (a.sol + a.usd / 1000));
    stats.topBuys = stats.topBuys.slice(0, 5);
  }

  const whales = Array.from(byWallet.values()).sort((a, b) => b.score - a.score);
  return { whales, coverage: { totalBuys: totalBuysSeen, pricedBuys: pricedBuysSeen } };
}

async function main(): Promise<void> {
  const { inPath, outPath, top, minSol, minTokens, minBuys, solPrice, format } = parseArgs();

  log.info(
    { inPath, outPath, top, minSol, minTokens, minBuys, solPrice },
    'extracting whales from cache',
  );
  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));
  const { symbolByMint, perTokenEvents } = unifyCache(raw);

  const totalEvents = Object.values(perTokenEvents).reduce((s, arr) => s + arr.length, 0);
  log.info(
    { tokens: Object.keys(perTokenEvents).length, totalEvents },
    'cache loaded',
  );

  const { whales: aggregated, coverage } = aggregateWhales(perTokenEvents, symbolByMint, solPrice);
  let whales = aggregated;
  const pricedPct = coverage.totalBuys > 0 ? (coverage.pricedBuys / coverage.totalBuys) * 100 : 0;
  log.info(
    {
      totalWallets: whales.length,
      pricedBuys: coverage.pricedBuys,
      totalBuys: coverage.totalBuys,
      pricedPct: pricedPct.toFixed(1) + '%',
    },
    'aggregation done',
  );
  if (pricedPct < 30) {
    log.warn(
      `only ${pricedPct.toFixed(1)}% of cached buys have pricing data — Jupiter doesn't price most ` +
        'fresh memecoins. Falling back to presence-based ranking (distinctTokens + buyCount). ' +
        'For better sizing data, regenerate cache: ' +
        '`PUMP_DUMP=cache/pump.json npm run watchlist:seed:pump`',
    );
  }

  // Apply filters in order: presence-based first (always work), then sized
  const before = whales.length;
  whales = whales.filter(
    (w) => w.distinctTokens >= minTokens && w.totalBuys >= minBuys && w.totalSol >= minSol,
  );
  log.info(
    { before, after: whales.length, minSol, minTokens, minBuys },
    'filters applied',
  );

  // Cap to top-N
  whales = whales.slice(0, top);

  // Print preview
  console.log(`\nTop ${Math.min(30, whales.length)} whales by composite score:`);
  console.log(
    'Wallet                                              Score  Tokens  Buys   Priced  TotalSOL  TotalUSD  TopBuys',
  );
  console.log(
    '--------------------------------------------------  -----  ------  -----  ------  --------  --------  -----------------------',
  );
  for (const w of whales.slice(0, 30)) {
    const wallet = w.wallet.padEnd(50);
    const score = w.score.toFixed(1).padStart(5);
    const tokens = String(w.distinctTokens).padStart(6);
    const buys = String(w.totalBuys).padStart(5);
    const priced = String(w.pricedBuys).padStart(6);
    const sol = w.totalSol.toFixed(1).padStart(8);
    const usd = ('$' + Math.round(w.totalUsd).toLocaleString()).padStart(8);
    const top3 = w.topBuys
      .slice(0, 3)
      .map((b) => {
        const size = b.sol > 0 ? `${b.sol.toFixed(1)}S` : b.usd > 0 ? `$${Math.round(b.usd)}` : '?';
        return `${b.symbol}(${size})`;
      })
      .join(', ');
    console.log(`${wallet}  ${score} ${tokens}  ${buys}  ${priced}  ${sol}  ${usd}  ${top3}`);
  }
  console.log('');

  // Write output
  const outDir = outPath.replace(/[/\\][^/\\]+$/, '');
  if (outDir && outDir !== outPath) {
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
  }
  if (format === 'csv') {
    const lines = ['wallet,score,distinct_tokens,total_buys,priced_buys,total_sol,total_usd'];
    for (const w of whales) {
      lines.push(
        `${w.wallet},${w.score.toFixed(2)},${w.distinctTokens},${w.totalBuys},${w.pricedBuys},${w.totalSol.toFixed(2)},${w.totalUsd.toFixed(2)}`,
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
