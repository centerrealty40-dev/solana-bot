import { desc, sql } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import { ensureDecisionsForWallets, queryScamFarmBlockWalletSet } from './ensure-decisions.js';
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

/**
 * Load wallets to score: scam participants first (до лимита), затем свежие entity_wallets.
 */
export async function runWalletIntelMaterialize(options: {
  dryRun: boolean;
  limitOverride?: number;
}): Promise<MaterializeMetrics> {
  const env = loadWalletIntelEnv();

  const limit = Math.min(
    options.limitOverride ?? env.policyWalletLimit,
    env.policyWalletLimit,
  );

  const scamBlockWallets = await queryScamFarmBlockWalletSet(env);

  const entityRows = await db
    .select({ wallet: schema.entityWallets.wallet })
    .from(schema.entityWallets)
    .where(
      sql`${schema.entityWallets.profileUpdatedAt} > now() - (${env.entityLookbackHours}::numeric * interval '1 hour')`,
    )
    .orderBy(desc(schema.entityWallets.profileUpdatedAt))
    .limit(limit);

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
    const ruleSetVersion = readProductRuleSetVersion(env.ruleSetVersionOverride);
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

  const full = await ensureDecisionsForWallets(walletList, {
    dryRun: options.dryRun,
    env,
    scamBlockWallets,
  });

  const { decisionsByWallet: _d, ...metrics } = full;
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
