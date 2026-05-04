import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import { classifyWallet } from './classify-wallet.js';
import { loadWalletIntelEnv } from './load-policy-env.js';
import { readProductRuleSetVersion } from './read-version.js';

const log = child('wallet-intel-policy');

export type MaterializeMetrics = {
  walletsConsidered: number;
  blockTrade: number;
  smartTierA: number;
  unknown: number;
  upserted: number;
  dryRun: boolean;
  ruleSetVersion: string;
};

function participantSetFromCandidates(
  rows: (typeof schema.scamFarmCandidates.$inferSelect)[],
): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    const arr = r.participantWallets ?? [];
    for (const w of arr) {
      if (w) s.add(w);
    }
  }
  return s;
}

/**
 * Load wallets to score: recent entity_wallets + optional union scam participants (capped).
 */
export async function runWalletIntelMaterialize(options: {
  dryRun: boolean;
  limitOverride?: number;
}): Promise<MaterializeMetrics> {
  const env = loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);

  const limit = Math.min(
    options.limitOverride ?? env.policyWalletLimit,
    env.policyWalletLimit,
  );

  const statusFilter =
    env.scamFarmBlockStatuses.length > 0
      ? env.scamFarmBlockStatuses
      : (['confirmed', 'needs_evidence'] as const);

  const candRows = await db
    .select()
    .from(schema.scamFarmCandidates)
    .where(
      and(
        eq(schema.scamFarmCandidates.reverted, false),
        inArray(schema.scamFarmCandidates.status, [...statusFilter]),
        gte(schema.scamFarmCandidates.score, env.scamFarmBlockMinScore),
      ),
    );

  const scamBlockWallets = participantSetFromCandidates(candRows);

  const entityRows = await db
    .select({ wallet: schema.entityWallets.wallet })
    .from(schema.entityWallets)
    .where(
      sql`${schema.entityWallets.profileUpdatedAt} > now() - (${env.entityLookbackHours}::numeric * interval '1 hour')`,
    )
    .orderBy(desc(schema.entityWallets.profileUpdatedAt))
    .limit(limit);

  /** Scam participants first (must get BLOCK rows), then recent Atlas wallets up to cap */
  const walletList: string[] = [];
  const seen = new Set<string>();
  for (const w of scamBlockWallets) {
    if (walletList.length >= limit) break;
    if (!seen.has(w)) {
      seen.add(w);
      walletList.push(w);
    }
  }
  for (const r of entityRows) {
    if (walletList.length >= limit) break;
    if (!seen.has(r.wallet)) {
      seen.add(r.wallet);
      walletList.push(r.wallet);
    }
  }

  if (walletList.length === 0) {
    log.warn('wallet-intel: no wallets to process');
    return {
      walletsConsidered: 0,
      blockTrade: 0,
      smartTierA: 0,
      unknown: 0,
      upserted: 0,
      dryRun: options.dryRun,
      ruleSetVersion,
    };
  }

  const tagRows = await db
    .select({
      wallet: schema.walletTags.wallet,
      tag: schema.walletTags.tag,
    })
    .from(schema.walletTags)
    .where(inArray(schema.walletTags.wallet, walletList));

  const tagsByWallet = new Map<string, Set<string>>();
  for (const row of tagRows) {
    let set = tagsByWallet.get(row.wallet);
    if (!set) {
      set = new Set();
      tagsByWallet.set(row.wallet, set);
    }
    set.add(row.tag);
  }

  let blockTrade = 0;
  let smartTierA = 0;
  let unknown = 0;
  let upserted = 0;

  const now = new Date();

  for (const wallet of walletList) {
    const tags = tagsByWallet.get(wallet) ?? new Set<string>();
    const r = classifyWallet(tags, {
      inScamFarmBlockSet: scamBlockWallets.has(wallet),
      botPrimarySuppressesSmart: env.botPrimarySuppressesSmart,
    });
    if (r.decision === 'BLOCK_TRADE') blockTrade += 1;
    else if (r.decision === 'SMART_TIER_A') smartTierA += 1;
    else unknown += 1;

    if (!options.dryRun) {
      await db
        .insert(schema.walletIntelDecisions)
        .values({
          walletAddress: wallet,
          ruleSetVersion,
          decision: r.decision,
          score: r.score,
          reasons: r.reasons,
          sources: r.sources,
          computedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.walletIntelDecisions.walletAddress,
            schema.walletIntelDecisions.ruleSetVersion,
          ],
          set: {
            decision: r.decision,
            score: r.score,
            reasons: r.reasons,
            sources: r.sources,
            computedAt: now,
          },
        });
    }
    upserted += 1;
  }

  const metrics: MaterializeMetrics = {
    walletsConsidered: walletList.length,
    blockTrade,
    smartTierA,
    unknown,
    upserted,
    dryRun: options.dryRun,
    ruleSetVersion,
  };
  log.info(metrics, 'wallet-intel materialize done');
  return metrics;
}

export async function insertWalletIntelRunRecord(args: {
  ruleSetVersion: string;
  metrics: Record<string, unknown>;
  status: 'ok' | 'failed';
  error?: string;
  startedAt: Date;
  finishedAt: Date;
}): Promise<void> {
  await db.insert(schema.walletIntelRuns).values({
    ruleSetVersion: args.ruleSetVersion,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    metrics: args.metrics,
    status: args.status,
    error: args.error ?? null,
  });
}
