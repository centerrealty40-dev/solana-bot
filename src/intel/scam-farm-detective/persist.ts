import { sql } from 'drizzle-orm';
import { desc, eq, or } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import type { ScamFarmConfig } from './config.js';
import { TAG_SOURCE } from './config.js';

export type CandidateStatus = 'open' | 'needs_evidence' | 'confirmed' | 'dismissed';

export type CandidateRow = typeof schema.scamFarmCandidates.$inferSelect;

export type CandidateRecord = {
  candidateId: string;
  funder: string | null;
  participantWallets: string[];
  anchorMints: string[];
  ruleIds: string[];
  score: number;
  artifacts: Record<string, unknown>;
  status: CandidateStatus;
  lastRunAt: Date;
};

export async function loadActiveCandidates(): Promise<CandidateRow[]> {
  return db
    .select()
    .from(schema.scamFarmCandidates)
    .where(
      or(
        eq(schema.scamFarmCandidates.status, 'open'),
        eq(schema.scamFarmCandidates.status, 'needs_evidence'),
        eq(schema.scamFarmCandidates.status, 'confirmed'),
      ),
    )
    .orderBy(desc(schema.scamFarmCandidates.lastRunAt));
}

/**
 * Idempotent: insert or full replace for `candidateId`, except preserve `wroteToAtlas` + `reverted` when set.
 */
export async function putCandidate(r: CandidateRecord): Promise<void> {
  const existing = await db
    .select()
    .from(schema.scamFarmCandidates)
    .where(eq(schema.scamFarmCandidates.candidateId, r.candidateId))
    .limit(1);
  const prev = existing[0];
  if (prev?.reverted) {
    return;
  }
  if (!prev) {
    await db.insert(schema.scamFarmCandidates).values({
      candidateId: r.candidateId,
      funder: r.funder,
      participantWallets: r.participantWallets,
      anchorMints: r.anchorMints,
      ruleIds: r.ruleIds,
      score: r.score,
      status: r.status,
      artifacts: r.artifacts,
      lastRunAt: r.lastRunAt,
      reverted: false,
      wroteToAtlas: false,
    });
    return;
  }
  const wrote = prev.wroteToAtlas;
  await db
    .update(schema.scamFarmCandidates)
    .set({
      funder: r.funder,
      participantWallets: r.participantWallets,
      anchorMints: r.anchorMints,
      ruleIds: r.ruleIds,
      score: r.score,
      status: r.status,
      artifacts: r.artifacts,
      lastRunAt: r.lastRunAt,
      updatedAt: new Date(),
      wroteToAtlas: wrote,
    })
    .where(eq(schema.scamFarmCandidates.candidateId, r.candidateId));
}

export async function setCandidateWroteAtlas(
  candidateId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const ex = await db
    .select()
    .from(schema.scamFarmCandidates)
    .where(eq(schema.scamFarmCandidates.candidateId, candidateId))
    .limit(1);
  const a = (ex[0]?.artifacts as Record<string, unknown>) ?? {};
  await db
    .update(schema.scamFarmCandidates)
    .set({
      wroteToAtlas: true,
      artifacts: { ...a, ...patch, atlasWriteAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(eq(schema.scamFarmCandidates.candidateId, candidateId));
}

/**
 * Dismiss very weak stale open rows to avoid unbounded growth.
 */
export async function dismissStale(c: ScamFarmConfig, log: (s: string) => void): Promise<number> {
  const days = c.dismissStaleDays;
  const maxScore = c.dismissMaxScore;
  const n = (await db.execute(sql`
    WITH u AS (
      UPDATE scam_farm_candidates
        SET status = 'dismissed', dismissed_at = now(), updated_at = now()
      WHERE status IN ('open','needs_evidence')
        AND reverted = false
        AND score < ${maxScore}
        AND COALESCE(last_run_at, created_at) < now() - (interval '1' day * ${days})
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM u
  `)) as unknown as Array<{ n: string | number }>;
  const count = Number(n[0]?.n ?? 0);
  if (count > 0) {
    log(`dismissed_stale: ${count}`);
  }
  return count;
}

export { TAG_SOURCE };
