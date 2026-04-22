/**
 * Program Research Update — записывает результаты ручного research'а
 * по топ-кандидатам стратегии B в таблицу programs.
 *
 * Каждый findings блок:
 *   - review_status: 'reviewed' | 'edge_found' | 'no_edge' | 'discarded'
 *   - our_priority: 'high' | 'medium' | 'low' | 'skip'
 *   - edge_type: короткий код возможного edge
 *   - notes: что мы поняли из docs (краткий summary)
 *
 * Если протокола нет в таблице (выпал из DefiLlama-выборки из-за размера),
 * INSERT новой строки с source='manual'.
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../src/core/db/client.js';

interface Finding {
  matchSlug?: string;     // если найден в БД от DefiLlama — используем slug match
  programId?: string;     // или явный programId для manual записи
  name: string;
  category: string;
  url: string;
  reviewStatus: 'reviewed' | 'edge_found' | 'no_edge' | 'discarded';
  priority: 'high' | 'medium' | 'low' | 'skip';
  edgeType: string | null;
  notes: string;
}

const FINDINGS: Finding[] = [
  // === HIGH PRIORITY (digging deeper) ===
  {
    matchSlug: 'pacifica-finance',
    name: 'Pacifica',
    category: 'Derivatives',
    url: 'https://docs.pacifica.fi',
    reviewStatus: 'edge_found',
    priority: 'high',
    edgeType: 'funding_rate_arb',
    notes: 'Hourly funding updates, sampling every 5s, TWAP displayed in advance. Premium index = (Impact Price - Oracle Price) where Impact Notional is $20k BTC / $6k others. Cap ±4%/hr. Funding payments deduct from isolated margin and recalc liquidation price. EDGE: open position 30-60s before funding payment on the receiving side, close after. Standard Hyperliquid-style pattern but few players on Solana yet. Need to verify: (1) funding tx visible in advance, (2) no priority-fee bidding war.',
  },
  {
    programId: 'manual:sanctum-infinity',
    name: 'Sanctum',
    category: 'Liquid Staking',
    url: 'https://learn.sanctum.so/docs/technical-documentation/reserve',
    reviewStatus: 'edge_found',
    priority: 'high',
    edgeType: 'reserve_fee_arb+epoch_boundary',
    notes: '~600k SOL Reserve pool. Dynamic instant-unstake fee 8-800bps based on pool utilization. Solana net rule: max 25% of active stake deactivates per epoch. EDGE 1: cross-pool LST arb — when Sanctum fee >200bps and LST trades -2% on Jupiter, buy LST cheap on DEX, instant unstake on Sanctum. EDGE 2: epoch boundary fee spike prediction. EDGE 3: monitor when Reserve drops below threshold → unstake demand will push price discount on LSTs across DEXes. Was excluded from DefiLlama auto-pull due to TVL>$500M filter — added manually.',
  },
  {
    matchSlug: 'rockawayx',
    name: 'RockawayX',
    category: 'Risk Curators',
    url: 'https://www.rockawayx.com/vaults',
    reviewStatus: 'reviewed',
    priority: 'high',
    edgeType: 'curator_vault_rebalance',
    notes: '$35M Solana TVL, growing +125%/7d. Curated vaults on Morpho with algorithmic rebalancing + human committee. EDGE: vault rebalance moves are large ($1-50M) and visible on-chain. Need to find their vault programIds and historical rebalance txs to characterize timing pattern. Real money, professional ops = no scam risk.',
  },
  {
    matchSlug: 'mooncake',
    name: 'Mooncake',
    category: 'Derivatives',
    url: 'https://docs.mooncake.fi',
    reviewStatus: 'reviewed',
    priority: 'medium',
    edgeType: 'leveraged_token_rebalance',
    notes: 'Leveraged Tokens (LT) auto-rebalance to maintain target leverage. Funding Tokens (FT/mUSD) lend to LT holders. EDGE: if rebalance trigger is on-chain predictable (cron or threshold) — frontrun the rebalance trade. LP earns rebalance fees. CONCERN: only $809k TVL → small absolute edge per trade.',
  },

  // === MEDIUM ===
  {
    matchSlug: 'gmtrade',
    name: 'GMTrade',
    category: 'Derivatives',
    url: 'https://docs.gmtrade.xyz',
    reviewStatus: 'reviewed',
    priority: 'medium',
    edgeType: 'price_impact_rebate_timing',
    notes: 'GMX V2 inspired Solana perp DEX, RWA focus. Adaptive funding rates. PRICE IMPACT REBATES claimable after ~10 days (scheduled). EDGE: rebate-claim window is predictable per user — can backrun claim events for arb. Less interesting than Pacifica funding play.',
  },
  {
    programId: 'manual:kamino',
    name: 'Kamino Finance',
    category: 'Yield Aggregator',
    url: 'https://docs.kamino.finance',
    reviewStatus: 'reviewed',
    priority: 'medium',
    edgeType: 'crank_rebalance_frontrun',
    notes: 'Vault rebalances triggered by off-chain bots via on-chain crank operations (CrankFundFee per reserve). Vault state is public on-chain → can predict when out-of-range. CONCERN: Solana has no mempool, all goes through Jito auctions → priority-fee bidding likely already optimized by competing MEV bots. Hard to win on speed; only win if our prediction is BETTER (leading the crank).',
  },

  // === LOW / DISCARDED ===
  {
    matchSlug: 'project-0',
    name: 'Project 0',
    category: 'Lending',
    url: 'https://docs.0.xyz',
    reviewStatus: 'reviewed',
    priority: 'low',
    edgeType: 'liquidation',
    notes: 'Built on mrgnLendv2 — sits on top of Marginfi. Has liquidator guides → external liquidations open. CONCERN: Marginfi liquidation pool already heavily contested. Project 0 layer might add small extra surface but core risk engine = same.',
  },
  {
    matchSlug: 'anoncoin',
    name: 'Anoncoin',
    category: 'Launchpad',
    url: 'https://anoncoin.it',
    reviewStatus: 'reviewed',
    priority: 'low',
    edgeType: 'graduation_arb',
    notes: 'Bonding curve → graduation at 420 SOL → Meteora DAMM Pool. Same pattern as pump.fun graduation arb — likely already saturated by sniper bots day-1. Only 6d old but the pattern is well known.',
  },
  {
    matchSlug: 'omnipair',
    name: 'Omnipair',
    category: 'Lending',
    url: 'https://docs.omnipair.fi',
    reviewStatus: 'discarded',
    priority: 'skip',
    edgeType: null,
    notes: 'NO EXTERNAL LIQUIDATIONS. Uses internal debt write-offs (partial for solvent, full for insolvent positions). Bad debt socialized to LPs. There is no third-party liquidator role to compete for → no MEV/arb edge for us.',
  },
  {
    matchSlug: 'hubra',
    name: 'Hubra',
    category: 'Yield',
    url: 'https://www.hubra.app',
    reviewStatus: 'discarded',
    priority: 'skip',
    edgeType: null,
    notes: 'Frontend aggregator over 20+ Solana platforms with raSOL liquid staking ($3M). No native edge — pure UX layer. Could later be useful as ROUTING reference (which platforms they integrate).',
  },
];

async function main() {
  console.log(`\n=== Program Research Update ===\n`);
  let updated = 0, inserted = 0, missing = 0;

  for (const f of FINDINGS) {
    if (f.matchSlug) {
      // Update by slug
      const r: any = await db.execute(dsql`
        UPDATE programs SET
          review_status = ${f.reviewStatus},
          our_priority  = ${f.priority},
          edge_type     = ${f.edgeType},
          notes         = ${f.notes},
          last_checked_at = now()
        WHERE slug = ${f.matchSlug}
        RETURNING program_id, name
      `);
      const rows = Array.isArray(r) ? r : (r.rows ?? []);
      if (rows.length > 0) {
        updated++;
        console.log(`  [UPDATE] ${f.name.padEnd(20)} priority=${f.priority.padEnd(7)} edge=${f.edgeType ?? '-'}`);
      } else {
        missing++;
        console.log(`  [SKIP]   ${f.name.padEnd(20)} slug='${f.matchSlug}' not found in programs`);
      }
    } else if (f.programId) {
      // Insert manual entry
      await db.insert(schema.programs).values({
        programId: f.programId,
        name: f.name,
        slug: f.programId.replace('manual:', ''),
        category: f.category,
        chain: 'solana',
        source: 'manual',
        url: f.url,
        reviewStatus: f.reviewStatus,
        ourPriority: f.priority,
        edgeType: f.edgeType,
        notes: f.notes,
      }).onConflictDoUpdate({
        target: schema.programs.programId,
        set: {
          reviewStatus: f.reviewStatus,
          ourPriority: f.priority,
          edgeType: f.edgeType,
          notes: f.notes,
          lastCheckedAt: new Date(),
        },
      });
      inserted++;
      console.log(`  [MANUAL] ${f.name.padEnd(20)} priority=${f.priority.padEnd(7)} edge=${f.edgeType ?? '-'}`);
    }
  }

  console.log(`\nUpdated: ${updated}  Inserted: ${inserted}  Missing: ${missing}\n`);

  // === Текущий shortlist по priority ===
  console.log(`${'='.repeat(76)}`);
  console.log(`ТЕКУЩИЙ SHORTLIST по priority`);
  console.log('='.repeat(76));
  const shortlist: any = await db.execute(dsql`
    SELECT name, category, our_priority, review_status, edge_type, tvl_usd, url
    FROM programs
    WHERE our_priority IN ('high','medium')
    ORDER BY
      CASE our_priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      tvl_usd DESC NULLS LAST
  `);
  const rows = Array.isArray(shortlist) ? shortlist : (shortlist.rows ?? []);
  for (const r of rows) {
    const tvl = r.tvl_usd
      ? (r.tvl_usd >= 1e6 ? `$${(r.tvl_usd/1e6).toFixed(1)}M` : `$${(r.tvl_usd/1e3).toFixed(0)}k`)
      : '?';
    console.log(
      `  [${String(r.our_priority).toUpperCase().padEnd(6)}] ${String(r.name).padEnd(20)} ${String(r.category ?? '?').padEnd(15)} ${tvl.padStart(7)}  edge=${r.edge_type ?? '-'}`,
    );
  }

  // === Распределение программ ===
  console.log(`\n${'='.repeat(60)}`);
  console.log(`СОСТОЯНИЕ programs В БД`);
  console.log('='.repeat(60));
  const stats: any = await db.execute(dsql`
    SELECT review_status, our_priority, COUNT(*)::int AS n
    FROM programs GROUP BY review_status, our_priority
    ORDER BY n DESC
  `);
  const sRows = Array.isArray(stats) ? stats : (stats.rows ?? []);
  for (const r of sRows) {
    console.log(`  ${String(r.review_status).padEnd(12)} ${String(r.our_priority).padEnd(8)} ${r.n}`);
  }

  console.log(`\nDONE.\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
