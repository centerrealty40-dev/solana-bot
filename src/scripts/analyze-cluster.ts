/**
 * Analyze a cluster of watchlist wallets that all bought the same mint.
 *
 * Use case: we discovered that 5 of our H8-rotation watchlist wallets
 * synchronously bought a honeypot token. We want to verify the hypothesis
 * that they are a SCAMMER's wallet cluster, not real alpha. The signature
 * pattern is:
 *   - high % of total volume concentrated on ONE token
 *   - few-to-zero trades on OTHER tokens
 *   - all funded by the same parent (or ring of parents)
 *   - all created recently (fresh wallets)
 *
 * Usage:
 *   npm run analyze:cluster -- 4hpCdBH9oz8Fhji5CdpJYbwa24FCSi967sSKhXPQbQtp
 */
import 'dotenv/config';
import { request } from 'undici';
import { config } from '../core/config.js';
import { db } from '../core/db/client.js';
import { sql as dsql } from 'drizzle-orm';
import { child } from '../core/logger.js';

const log = child('analyze-cluster');
const HELIUS = `https://api.helius.xyz/v0`;

interface HeliusTx {
  signature: string;
  timestamp: number;
  type?: string;
  source?: string;
  feePayer?: string;
  tokenTransfers?: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    tokenAmount: number;
    mint: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount: string | null;
    toUserAccount: string | null;
    amount: number;
  }>;
}

async function fetchTxs(wallet: string, limit = 100): Promise<HeliusTx[]> {
  const url = `${HELIUS}/addresses/${wallet}/transactions?api-key=${config.heliusApiKey}&limit=${limit}`;
  const r = await request(url);
  if (r.statusCode !== 200) {
    log.warn({ wallet, status: r.statusCode }, 'helius non-200');
    return [];
  }
  const j = (await r.body.json()) as HeliusTx[];
  return Array.isArray(j) ? j : [];
}

interface WalletStats {
  wallet: string;
  totalTxs: number;
  firstSeen: number;
  lastSeen: number;
  uniqueMints: number;
  topMint: { mint: string; count: number; volume: number } | null;
  topMintShare: number;
  funders: Array<{ wallet: string; sol: number }>;
}

async function analyzeWallet(wallet: string, target: string): Promise<WalletStats> {
  const txs = await fetchTxs(wallet, 100);

  const mintCounts = new Map<string, { count: number; volume: number }>();
  const funderSol = new Map<string, number>();
  let firstSeen = Number.MAX_SAFE_INTEGER;
  let lastSeen = 0;

  for (const tx of txs) {
    if (tx.timestamp) {
      firstSeen = Math.min(firstSeen, tx.timestamp);
      lastSeen = Math.max(lastSeen, tx.timestamp);
    }
    // Identify which mints the wallet TOUCHED (any side)
    const touched = new Set<string>();
    let totalVol = 0;
    for (const t of tx.tokenTransfers ?? []) {
      if (t.fromUserAccount === wallet || t.toUserAccount === wallet) {
        touched.add(t.mint);
        totalVol += Math.abs(t.tokenAmount);
      }
    }
    for (const m of touched) {
      const cur = mintCounts.get(m) ?? { count: 0, volume: 0 };
      cur.count += 1;
      cur.volume += totalVol;
      mintCounts.set(m, cur);
    }
    // Funders: anyone who sent SOL to this wallet via nativeTransfers
    for (const nt of tx.nativeTransfers ?? []) {
      if (nt.toUserAccount === wallet && nt.fromUserAccount && nt.amount > 0) {
        const sol = nt.amount / 1e9;
        if (sol >= 0.01) {
          funderSol.set(nt.fromUserAccount, (funderSol.get(nt.fromUserAccount) ?? 0) + sol);
        }
      }
    }
  }

  const sorted = [...mintCounts.entries()].sort((a, b) => b[1].count - a[1].count);
  const top = sorted[0];
  const totalCount = [...mintCounts.values()].reduce((s, x) => s + x.count, 0);

  // Filter mints to non-quote
  const QUOTE = new Set([
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KConKyFmvXZK7K1tD9',
  ]);
  const nonQuoteSorted = sorted.filter(([m]) => !QUOTE.has(m));
  const realTop = nonQuoteSorted[0] ?? top;

  const funders = [...funderSol.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w, s]) => ({ wallet: w, sol: s }));

  // Confirm wallet bought the target
  const targetEntry = mintCounts.get(target);

  return {
    wallet,
    totalTxs: txs.length,
    firstSeen: firstSeen === Number.MAX_SAFE_INTEGER ? 0 : firstSeen,
    lastSeen,
    uniqueMints: mintCounts.size,
    topMint: realTop
      ? { mint: realTop[0], count: realTop[1].count, volume: realTop[1].volume }
      : null,
    topMintShare: totalCount > 0 ? (targetEntry?.count ?? 0) / totalCount : 0,
  funders,
  };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: npm run analyze:cluster -- <baseMint>');
    process.exit(1);
  }

  // Find watchlist wallets that bought this mint
  const buyers = (await db.execute(
    dsql.raw(`
      SELECT DISTINCT s.wallet
      FROM swaps s JOIN watchlist_wallets w ON w.wallet = s.wallet
      WHERE w.removed_at IS NULL
        AND s.base_mint = '${target}'
        AND s.side = 'buy'
    `),
  )) as unknown as Array<{ wallet: string }>;

  console.log(`\n=== Analyzing cluster around ${target} ===\n`);
  console.log(`Watchlist wallets that bought it: ${buyers.length}\n`);

  if (buyers.length === 0) {
    console.log('(nobody from watchlist bought this — nothing to analyze)');
    process.exit(0);
  }

  const stats: WalletStats[] = [];
  for (const b of buyers) {
    process.stdout.write(`Pulling history for ${b.wallet}... `);
    const s = await analyzeWallet(b.wallet, target);
    stats.push(s);
    console.log(`done (${s.totalTxs} txs)`);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n=== Per-wallet breakdown ===\n');
  for (const s of stats) {
    const ageDays = s.firstSeen ? (Date.now() / 1000 - s.firstSeen) / 86400 : 0;
    console.log(`${s.wallet}`);
    console.log(`  txs in last 100:    ${s.totalTxs}`);
    console.log(`  oldest tx age:      ${ageDays.toFixed(1)} days`);
    console.log(`  unique mints touched: ${s.uniqueMints}`);
    console.log(
      `  top mint:           ${s.topMint?.mint?.slice(0, 16) ?? '-'}... (${s.topMint?.count ?? 0} txs)`,
    );
    console.log(`  share on TARGET:    ${(s.topMintShare * 100).toFixed(0)}% of total tx-touches`);
    console.log(`  top SOL funders:`);
    for (const f of s.funders) {
      console.log(`    ${f.wallet}  ${f.sol.toFixed(2)} SOL`);
    }
    console.log('');
  }

  // Cross-wallet pattern detection
  console.log('=== Cluster verdict ===\n');

  const sharedFunders = new Map<string, number>();
  for (const s of stats) {
    for (const f of s.funders) {
      sharedFunders.set(f.wallet, (sharedFunders.get(f.wallet) ?? 0) + 1);
    }
  }
  const commonFunders = [...sharedFunders.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (commonFunders.length > 0) {
    console.log(`SHARED FUNDERS (likely operator's treasury):`);
    for (const [w, c] of commonFunders) {
      console.log(`  ${w}  funded ${c}/${stats.length} cluster wallets`);
    }
    console.log('');
  } else {
    console.log('No directly-shared funders (intermediary wallets used)\n');
  }

  const monomaniacs = stats.filter((s) => s.topMintShare >= 0.5);
  const fresh = stats.filter((s) => s.firstSeen && (Date.now() / 1000 - s.firstSeen) / 86400 < 14);
  const veryFresh = stats.filter((s) => s.firstSeen && (Date.now() / 1000 - s.firstSeen) / 86400 < 1);

  // Detect "uniform funding through intermediaries" — the scammer's usual
  // obfuscation: route ~same SOL amount through N different wallets to avoid
  // a direct shared-funder link. If primary funding amounts are within ±20%
  // of each other AND all wallets are fresh, that is itself a strong signal.
  const primaryAmounts = stats
    .map((s) => s.funders[0]?.sol ?? 0)
    .filter((x) => x > 0);
  let uniformFunding = false;
  let mean = 0;
  let cv = 1; // coefficient of variation
  if (primaryAmounts.length >= 3) {
    mean = primaryAmounts.reduce((a, b) => a + b, 0) / primaryAmounts.length;
    const variance =
      primaryAmounts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / primaryAmounts.length;
    const stdev = Math.sqrt(variance);
    cv = mean > 0 ? stdev / mean : 1;
    uniformFunding = cv < 0.15; // < 15% spread = clearly coordinated
  }

  const score =
    (commonFunders.length > 0 ? 40 : 0) +
    (uniformFunding ? 35 : 0) +
    (monomaniacs.length / stats.length) * 25 +
    (veryFresh.length / stats.length) * 25 +
    (fresh.length === stats.length && veryFresh.length < stats.length ? 10 : 0);

  console.log(`Scam confidence: ${Math.min(100, score).toFixed(0)}/100`);
  console.log(`  - shared funder direct:          ${commonFunders.length > 0 ? 'YES (+40)' : 'no'}`);
  console.log(
    `  - uniform funding via intermediaries: ${uniformFunding ? `YES — ${primaryAmounts.length} funders sent ~${mean.toFixed(0)} SOL each (cv=${(cv * 100).toFixed(0)}%) (+35)` : `no (cv=${(cv * 100).toFixed(0)}%)`}`,
  );
  console.log(
    `  - monomaniacs (>=50% on TARGET): ${monomaniacs.length}/${stats.length}  (+${((monomaniacs.length / stats.length) * 25).toFixed(0)})`,
  );
  console.log(
    `  - very fresh wallets (<1d):      ${veryFresh.length}/${stats.length}  (+${((veryFresh.length / stats.length) * 25).toFixed(0)})`,
  );
  console.log(
    `  - all fresh (<14d):              ${fresh.length}/${stats.length}  ${fresh.length === stats.length && veryFresh.length < stats.length ? '(+10)' : ''}`,
  );
  if (score >= 60) {
    console.log(`\n⚠️  VERDICT: SCAMMER CLUSTER — recommend removing all ${stats.length} wallets from watchlist`);
    console.log(`To remove, run:`);
    console.log(`  PURGE_CONFIRM=1 npm run cluster:purge -- ${target}`);
    console.log(`  npm run webhook:register`);
  } else if (score >= 40) {
    console.log(`\nVerdict: SUSPICIOUS — manual review recommended (${score.toFixed(0)}/100)`);
  } else {
    console.log(`\nVerdict: probably real alpha (${score.toFixed(0)}/100)`);
  }

  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'analyze failed');
  process.exit(1);
});
