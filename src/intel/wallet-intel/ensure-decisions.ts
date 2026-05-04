import { and, eq, gte, inArray } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import { classifyWallet } from './classify-wallet.js';
import type { WalletIntelEnv } from './load-policy-env.js';
import { loadWalletIntelEnv } from './load-policy-env.js';
import { readProductRuleSetVersion } from './read-version.js';

const log = child('wallet-intel-ensure');

export type EnsureMetrics = {
  walletsConsidered: number;
  blockTrade: number;
  smartTierA: number;
  unknown: number;
  upserted: number;
  dryRun: boolean;
  ruleSetVersion: string;
};

export type EnsureResult = EnsureMetrics & {
  decisionsByWallet: Map<string, string>;
};

function participantSetFromCandidates(
  rows: (typeof schema.scamFarmCandidates.$inferSelect)[],
): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    for (const w of r.participantWallets ?? []) {
      if (w) s.add(w);
    }
  }
  return s;
}

/** Участники scam_farm_candidates выше порога — для BLOCK_TRADE в политике. */
export async function queryScamFarmBlockWalletSet(env: WalletIntelEnv): Promise<Set<string>> {
  const statusFilter =
    env.scamFarmBlockStatuses.length > 0 ? env.scamFarmBlockStatuses : ['confirmed', 'needs_evidence'];

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

  return participantSetFromCandidates(candRows);
}

/** wallet_tags ∪ entity_wallets.primary_tag */
export async function mergeTagsForWallets(walletList: string[]): Promise<Map<string, Set<string>>> {
  if (walletList.length === 0) {
    return new Map();
  }

  const tagRows = await db
    .select({
      wallet: schema.walletTags.wallet,
      tag: schema.walletTags.tag,
    })
    .from(schema.walletTags)
    .where(inArray(schema.walletTags.wallet, walletList));

  const primRows = await db
    .select({
      wallet: schema.entityWallets.wallet,
      primaryTag: schema.entityWallets.primaryTag,
    })
    .from(schema.entityWallets)
    .where(inArray(schema.entityWallets.wallet, walletList));

  const tagsByWallet = new Map<string, Set<string>>();
  for (const row of tagRows) {
    let set = tagsByWallet.get(row.wallet);
    if (!set) {
      set = new Set();
      tagsByWallet.set(row.wallet, set);
    }
    set.add(row.tag);
  }
  for (const row of primRows) {
    if (!row.primaryTag) continue;
    let set = tagsByWallet.get(row.wallet);
    if (!set) {
      set = new Set();
      tagsByWallet.set(row.wallet, set);
    }
    set.add(row.primaryTag);
  }

  return tagsByWallet;
}

/**
 * Классификация и upsert решений для явного списка адресов (mint-check, адресные батчи).
 */
export async function ensureDecisionsForWallets(
  walletList: string[],
  options: {
    dryRun: boolean;
    ruleSetVersionOverride?: string;
    env?: WalletIntelEnv;
    scamBlockWallets?: Set<string>;
  },
): Promise<EnsureResult> {
  const env = options.env ?? loadWalletIntelEnv();
  const ruleSetVersion = readProductRuleSetVersion(
    options.ruleSetVersionOverride ?? env.ruleSetVersionOverride,
  );

  const scamBlockWallets = options.scamBlockWallets ?? (await queryScamFarmBlockWalletSet(env));
  const decisionsByWallet = new Map<string, string>();

  if (walletList.length === 0) {
    return {
      walletsConsidered: 0,
      blockTrade: 0,
      smartTierA: 0,
      unknown: 0,
      upserted: 0,
      dryRun: options.dryRun,
      ruleSetVersion,
      decisionsByWallet,
    };
  }

  const tagsByWallet = await mergeTagsForWallets(walletList);

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

    decisionsByWallet.set(wallet, r.decision);

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

  const metrics: EnsureResult = {
    walletsConsidered: walletList.length,
    blockTrade,
    smartTierA,
    unknown,
    upserted,
    dryRun: options.dryRun,
    ruleSetVersion,
    decisionsByWallet,
  };
  const { decisionsByWallet: _decisionsMap, ...logPayload } = metrics;
  log.info(logPayload, 'wallet-intel ensure batch done');
  return metrics;
}
