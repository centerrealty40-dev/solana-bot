import { eq } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import { pickPrimaryTagFromSet, PRIMARY_TAG_PRIORITY } from '../wallet-tagger.js';
import type { ScamFarmConfig } from './config.js';
import { TAG_SOURCE } from './config.js';
import { setCandidateWroteAtlas, type CandidateStatus } from './persist.js';

const log = child('scam-farm-atlas');

const PRIORITY = PRIMARY_TAG_PRIORITY;

type Role = 'funder' | 'member';

export type AtlasCandidateRow = {
  candidateId: string;
  funder: string | null;
  participantWallets: string[];
  anchorMints: string[];
  ruleIds: string[];
  score: number;
  status: CandidateStatus;
  reverted: boolean;
  wroteToAtlas: boolean;
  artifacts: Record<string, unknown>;
};

/**
 * After confirmation + score threshold: write `wallet_clusters`, `entity_wallets`, `wallet_tags` idempotently.
 */
export async function writeScamFarmToAtlas(
  c: ScamFarmConfig,
  row: AtlasCandidateRow,
  options: { dryRun: boolean },
): Promise<boolean> {
  if (row.reverted) {
    return false;
  }
  if (c.dryRun || options.dryRun) {
    log.info({ id: row.candidateId, dry: true }, 'atlas write skipped (dry run)');
    return false;
  }
  if (!c.writeAtlas) {
    return false;
  }
  if (row.wroteToAtlas) {
    return false;
  }
  if (row.score < c.confirmWriteScore) {
    return false;
  }
  const st: CandidateStatus = row.status;
  const eligible: boolean =
    st === 'confirmed' ||
    row.score >= c.strongScore ||
    (c.atlasWriteBelowConfirmed && st === 'needs_evidence' && row.score >= c.confirmWriteScore);
  if (!eligible) {
    return false;
  }

  const funder = row.funder;
  const members = [...new Set(row.participantWallets)];

  if (members.length < 1) {
    return false;
  }

  const conf = Math.min(100, Math.round(row.score));
  const short = row.candidateId.slice(0, 10);
  const label = `scam farm (${short}… rules=${row.ruleIds.join('+') || 'n/a'})`;
  const touchedMints = row.anchorMints as string[];

  const inserted = await db
    .insert(schema.walletClusters)
    .values({
      label,
      kind: 'sniper_farm',
      confidence: conf,
      walletCount: members.length,
      firstActivityAt: new Date(),
      lastActivityAt: new Date(),
      totalInflowSol: 0,
      touchedMints: touchedMints,
      detectedBy: TAG_SOURCE,
      note: `candidate:${row.candidateId}`,
    })
    .returning({ id: schema.walletClusters.id });

  const clusterId = inserted[0]?.id;
  if (!clusterId) {
    log.error('cluster insert had no id');
    return false;
  }
  for (const w of members) {
    await upsertEntityClusterOnly(w, Number(clusterId));
  }
  if (funder && !members.includes(funder)) {
    await upsertEntityClusterOnly(funder, Number(clusterId));
  }

  for (const w of members) {
    const role: Role = funder && w === funder ? 'funder' : 'member';
    await addTagIdempotent(
      w,
      role === 'funder' ? 'scam_proxy' : 'scam_operator',
      conf,
      {
        role,
        clusterId: Number(clusterId),
        funder: funder ?? null,
        mints: row.anchorMints,
        rules: row.ruleIds,
        candidateId: row.candidateId,
        score: row.score,
      },
    );
  }

  if (funder && !members.includes(funder)) {
    await addTagIdempotent(funder, 'scam_proxy', conf, {
      role: 'funder' as const,
      clusterId: Number(clusterId),
      funder,
      mints: row.anchorMints,
      rules: row.ruleIds,
      candidateId: row.candidateId,
      score: row.score,
    });
  }

  if (c.updatePrimaryTag) {
    const toPrimary = funder && !members.includes(funder) ? [...members, funder] : members;
    for (const w of new Set(toPrimary)) {
      await tryUpdatePrimaryForWallet(w, c);
    }
  }

  await setCandidateWroteAtlas(row.candidateId, { clusterId: Number(clusterId) });
  log.info(
    { candidateId: row.candidateId, clusterId, tagged: members.length, funder },
    'wrote to atlas',
  );
  return true;
}

async function upsertEntityClusterOnly(wallet: string, clusterId: number): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.entityWallets)
    .values({
      wallet,
      clusterId,
      profileCreatedAt: now,
      profileUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.entityWallets.wallet,
      set: {
        clusterId,
        profileUpdatedAt: now,
      },
    });
}

async function tryUpdatePrimaryForWallet(wallet: string, c: ScamFarmConfig): Promise<void> {
  if (!c.updatePrimaryTag) {
    return;
  }
  const now = new Date();
  const tags = (await db
    .select({ tag: schema.walletTags.tag })
    .from(schema.walletTags)
    .where(eq(schema.walletTags.wallet, wallet))
    .then((r) => r.map((x) => x.tag))) as string[];
  const primary = pickPrimaryTagFromSet(new Set(tags));
  if (!primary) {
    return;
  }
  const current = await db
    .select({ primaryTag: schema.entityWallets.primaryTag })
    .from(schema.entityWallets)
    .where(eq(schema.entityWallets.wallet, wallet))
    .limit(1);
  const old = current[0]?.primaryTag;
  if (!old) {
    await db
      .update(schema.entityWallets)
      .set({ primaryTag: primary })
      .where(eq(schema.entityWallets.wallet, wallet));
    return;
  }
  const oi = PRIORITY.indexOf(old as (typeof PRIORITY)[number]);
  const ni = PRIORITY.indexOf(primary as (typeof PRIORITY)[number]);
  if (old !== undefined && oi >= 0 && (ni < 0 || ni >= oi)) {
    return;
  }
  await db
    .update(schema.entityWallets)
    .set({ primaryTag: primary, profileUpdatedAt: now })
    .where(eq(schema.entityWallets.wallet, wallet));
}

function ctxJson(meta: Record<string, unknown>): string {
  return JSON.stringify(meta);
}

async function addTagIdempotent(
  wallet: string,
  tag: 'scam_operator' | 'scam_proxy',
  conf: number,
  meta: Record<string, unknown>,
): Promise<void> {
  const context = ctxJson(meta);
  await db
    .insert(schema.walletTags)
    .values({
      wallet,
      tag,
      confidence: conf,
      source: TAG_SOURCE,
      context: context.length > 8000 ? context.slice(0, 7990) + '…' : context,
    })
    .onConflictDoNothing();
}
