import { sql, eq } from 'drizzle-orm';
import { db, schema } from '../../../core/db/client.js';
import type { ScamFarmGraphConfig } from './config.js';
import {
  SOURCE_GRAPH,
  SOURCE_META,
  SOURCE_TEMPORAL,
  TAG_FARM_META_MEMBER,
  TAG_FARM_SINK,
  TAG_FARM_TREASURY,
  TAG_RELAY_HUB,
  TAG_TIME_COHORT,
  TAG_CEX_DEPOSIT_HINT,
} from './constants.js';

const CTX_MAX = 7900;

export function truncateContext(payload: Record<string, unknown>): string {
  const s = JSON.stringify(payload);
  if (s.length <= CTX_MAX) return s;
  return `${s.slice(0, CTX_MAX - 1)}…`;
}

export async function upsertWalletTag(
  wallet: string,
  tag: string,
  source: string,
  confidence: number,
  context: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(schema.walletTags)
    .values({
      wallet,
      tag,
      source,
      confidence,
      context: truncateContext(context),
    })
    .onConflictDoNothing();
}

export async function upsertMetaClusterRecord(
  fingerprint: string,
  label: string,
  confidence: number,
  detectionReason: Record<string, unknown>,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .insert(schema.scamFarmMetaClusters)
    .values({
      fingerprint,
      label,
      confidence,
      detectionReason,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.scamFarmMetaClusters.fingerprint,
      set: {
        updatedAt: now,
        detectionReason,
        confidence,
        label,
      },
    })
    .returning({ id: schema.scamFarmMetaClusters.id });

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('meta cluster upsert returned no id');
  return id;
}

export async function replaceMetaMembers(
  metaClusterId: number,
  members: Array<{ wallet: string; role: string }>,
): Promise<void> {
  await db
    .delete(schema.scamFarmMetaClusterMembers)
    .where(eq(schema.scamFarmMetaClusterMembers.metaClusterId, metaClusterId));
  if (members.length < 1) return;
  await db.insert(schema.scamFarmMetaClusterMembers).values(
    members.map((m) => ({
      metaClusterId,
      wallet: m.wallet,
      role: m.role,
    })),
  );
}

export async function replaceMetaCandidates(metaClusterId: number, candidateIds: string[]): Promise<void> {
  await db
    .delete(schema.scamFarmMetaClusterCandidates)
    .where(eq(schema.scamFarmMetaClusterCandidates.metaClusterId, metaClusterId));
  if (candidateIds.length < 1) return;
  await db.insert(schema.scamFarmMetaClusterCandidates).values(
    candidateIds.map((candidateId) => ({ metaClusterId, candidateId })),
  );
}

export async function resolveCandidateIdsForWallets(wallets: string[]): Promise<string[]> {
  if (wallets.length < 1) return [];
  const rows = (await db.execute(sql`
    SELECT DISTINCT c.candidate_id AS candidate_id
    FROM scam_farm_candidates c
    WHERE (
      c.funder IS NOT NULL
      AND c.funder IN (${sql.join(
        wallets.map((w) => sql`${w}`),
        sql`, `,
      )})
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(c.participant_wallets) pt(val)
      WHERE pt.val IN (${sql.join(
        wallets.map((w) => sql`${w}`),
        sql`, `,
      )})
    )
  `)) as unknown as Array<{ candidate_id: string }>;
  return rows.map((r) => r.candidate_id).filter(Boolean);
}

export async function persistFarmMetaMemberTags(
  cfg: ScamFarmGraphConfig,
  metaClusterId: number,
  wallets: string[],
  rolesByWallet: Map<string, string>,
  candidateIds: string[],
): Promise<void> {
  if (cfg.dryRun) return;
  const conf = cfg.confidenceMetaMember;
  for (const w of wallets) {
    await upsertWalletTag(w, TAG_FARM_META_MEMBER, SOURCE_META, conf, {
      metaClusterId,
      role: rolesByWallet.get(w) ?? 'unknown',
      candidateIds: candidateIds.slice(0, 40),
    });
  }
}

export async function applySinkTreasuryTags(
  cfg: ScamFarmGraphConfig,
  hit: { targetWallet: string; nSources: number; totalSol: number },
  tier: 'sink' | 'treasury',
): Promise<void> {
  if (cfg.dryRun) return;
  const tag = tier === 'treasury' ? TAG_FARM_TREASURY : TAG_FARM_SINK;
  const confidence = tier === 'treasury' ? cfg.confidenceTreasury : cfg.confidenceSink;
  await upsertWalletTag(hit.targetWallet, tag, SOURCE_GRAPH, confidence, {
    nSources: hit.nSources,
    totalSol: hit.totalSol,
    tier,
  });
}

export async function applyRelayTag(
  cfg: ScamFarmGraphConfig,
  hub: string,
  nIn: number,
  nOut: number,
): Promise<void> {
  if (cfg.dryRun) return;
  await upsertWalletTag(hub, TAG_RELAY_HUB, SOURCE_GRAPH, cfg.confidenceRelay, { nIn, nOut });
}

export async function applyTemporalTag(cfg: ScamFarmGraphConfig, wallet: string, mint: string, tmin: string): Promise<void> {
  if (cfg.dryRun) return;
  await upsertWalletTag(wallet, TAG_TIME_COHORT, SOURCE_TEMPORAL, cfg.confidenceTemporal, {
    mint,
    tmin,
  });
}

export async function applyCexHintTag(cfg: ScamFarmGraphConfig, wallet: string, note: string): Promise<void> {
  if (cfg.dryRun) return;
  await upsertWalletTag(wallet, TAG_CEX_DEPOSIT_HINT, SOURCE_GRAPH, cfg.cexHintConfidence, {
    note,
  });
}
