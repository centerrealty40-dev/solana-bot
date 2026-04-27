import { eq } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import { child } from '../../core/logger.js';
import { makeCandidateId } from './candidate-id.js';
import { loadScamFarmConfig, type ScamFarmConfig, TAG_SOURCE } from './config.js';
import { appendFileLogLine } from './file-log.js';
import { putCandidate, dismissStale, type CandidateStatus, type CandidateRecord } from './persist.js';
import { querySyncFunding, queryRugCohortByFunder, queryOrchestratedSplit } from './queries.js';
import { shouldAutoConfirm, scoreForRules } from './scoring.js';
import { writeScamFarmToAtlas, type AtlasCandidateRow } from './atlas-write.js';
import { maybeAlchemyProbes, type RpcCounters } from './rpc-probe.js';

const log = child('scam-farm-detective');

export type RunMetrics = {
  syncFundHits: number;
  rugCohortHits: number;
  orchestrationHits: number;
  candidatesUpserted: number;
  candidatesConfirmed: number;
  wroteToAtlas: number;
  dismissedStale: number;
  rpcCalls: number;
  dryRun: boolean;
  writeAtlas: boolean;
};

type Agg = {
  funder: string | null;
  participants: Set<string>;
  anchors: Set<string>;
  rules: Set<string>;
  artifacts: Record<string, unknown>;
};

function toAtlasRow(r: typeof schema.scamFarmCandidates.$inferSelect): AtlasCandidateRow {
  return {
    candidateId: r.candidateId,
    funder: r.funder,
    participantWallets: (r.participantWallets as string[]) ?? [],
    anchorMints: (r.anchorMints as string[]) ?? [],
    ruleIds: (r.ruleIds as string[]) ?? [],
    score: r.score,
    status: r.status as CandidateStatus,
    reverted: r.reverted,
    wroteToAtlas: r.wroteToAtlas,
    artifacts: (r.artifacts as Record<string, unknown>) ?? {},
  };
}

function recToAtlas(r: CandidateRecord, reverted: boolean, wroteToAtlas: boolean): AtlasCandidateRow {
  return {
    candidateId: r.candidateId,
    funder: r.funder,
    participantWallets: r.participantWallets,
    anchorMints: r.anchorMints,
    ruleIds: r.ruleIds,
    score: r.score,
    status: r.status,
    reverted,
    wroteToAtlas,
    artifacts: r.artifacts,
  };
}

function statusFromScore(
  score: number,
  rules: string[],
  c: ScamFarmConfig,
  ruleCount: number,
): CandidateStatus {
  if (shouldAutoConfirm(score, rules, c.strongScore) || score >= c.strongScore) {
    return 'confirmed';
  }
  if (score < 30) {
    return 'open';
  }
  if (ruleCount < 2 && score < 55) {
    return 'needs_evidence';
  }
  return 'needs_evidence';
}

/**
 * One full detection pass: SQL signals → merge → persist → optional atlas + RPC.
 */
export async function runScamFarmDetectivePass(_options: { config?: ScamFarmConfig } = {}): Promise<RunMetrics> {
  const c = _options.config ?? loadScamFarmConfig();
  const m = (msg: string) => {
    try {
      appendFileLogLine(c.logPath, msg);
    } catch {
      /* */
    }
    log.info({ line: msg.slice(0, 500) }, 'scam-farm file-log');
  };

  const [sync, rug, orch] = await Promise.all([
    querySyncFunding(db, c),
    queryRugCohortByFunder(db, c),
    queryOrchestratedSplit(db, c),
  ]);

  const aggs = new Map<string, Agg>();

  const merge = (id: string, patch: {
    funder: string | null;
    participants: string[];
    anchors: string[];
    rule: string;
    artifactKey: string;
    artifact: unknown;
  }): void => {
    const cur: Agg = aggs.get(id) ?? {
      funder: null,
      participants: new Set<string>(),
      anchors: new Set<string>(),
      rules: new Set<string>(),
      artifacts: {} as Record<string, unknown>,
    };
    if (patch.funder) {
      cur.funder = patch.funder;
    }
    for (const w of patch.participants) {
      if (w) {
        cur.participants.add(w);
      }
    }
    for (const t of patch.anchors) {
      if (t) {
        cur.anchors.add(t);
      }
    }
    cur.rules.add(patch.rule);
    cur.artifacts[patch.artifactKey] = patch.artifact;
    aggs.set(id, cur);
  };

  for (const row of sync) {
    const t = (row.targets ?? []).filter(Boolean);
    if (t.length < 1) {
      continue;
    }
    const id = makeCandidateId({ funder: row.sourceWallet, wallets: t, anchorMints: [] });
    merge(id, {
      funder: row.sourceWallet,
      participants: t,
      anchors: [],
      rule: 'sync_fund',
      artifactKey: 'sync_fund',
      artifact: { bucket: row.bucket, nTargets: row.nTargets, minA: row.minA, maxA: row.maxA },
    });
  }

  for (const row of rug) {
    const w = (row.earlyWallets ?? []).filter(Boolean);
    if (w.length < 1) {
      continue;
    }
    const id = makeCandidateId({ funder: row.funder, wallets: w, anchorMints: [row.anchorMint] });
    merge(id, {
      funder: row.funder,
      participants: w,
      anchors: [row.anchorMint],
      rule: 'rug_cohort',
      artifactKey: 'rug_cohort',
      artifact: { anchor: row.anchorMint, n: row.nWallets },
    });
  }

  for (const row of orch) {
    const id = makeCandidateId({ funder: null, wallets: [row.buyer, row.seller], anchorMints: [row.mint] });
    merge(id, {
      funder: null,
      participants: [row.buyer, row.seller],
      anchors: [row.mint],
      rule: 'orchestrate_split',
      artifactKey: 'orchestrate_split',
      artifact: { buy: row.buyT, sell: row.sellT, link: row.link, mint: row.mint },
    });
  }

  const rpcCounters: RpcCounters = { calls: 0 };
  if (c.enableRpc) {
    for (const [, a] of aggs) {
      if (rpcCounters.calls >= c.rpcBudget) {
        break;
      }
      await maybeAlchemyProbes(c, [...a.participants], rpcCounters);
    }
  }

  const now = new Date();
  let candidatesUpserted = 0;
  let candidatesConfirmed = 0;
  let wroteToAtlas = 0;
  for (const [candidateId, a] of aggs) {
    const rules = [...a.rules];
    const wallList = [...a.participants];
    const anchorList = [...a.anchors];
    const funder = a.funder;
    const { score, reasons } = scoreForRules(rules, {
      funder,
      walletCount: wallList.length,
      anchorCount: anchorList.length,
    });
    let st: CandidateStatus = statusFromScore(score, rules, c, rules.length);
    if (shouldAutoConfirm(score, rules, c.strongScore) || score >= c.strongScore) {
      st = 'confirmed';
    }
    if (st === 'confirmed') {
      candidatesConfirmed += 1;
    }

    const rec: CandidateRecord = {
      candidateId,
      funder,
      participantWallets: wallList,
      anchorMints: anchorList,
      ruleIds: rules,
      score,
      status: st,
      lastRunAt: now,
      artifacts: { ...a.artifacts, scoreReasons: reasons, _source: TAG_SOURCE, _rpc: rpcCounters },
    };
    if (!c.dryRun) {
      await putCandidate(rec);
    }
    candidatesUpserted += 1;

    if (c.dryRun) {
      const did = await writeScamFarmToAtlas(
        c,
        recToAtlas(rec, false, false),
        { dryRun: true },
      );
      if (did) {
        wroteToAtlas += 1;
      }
    } else {
      const rowDb = (
        await db
          .select()
          .from(schema.scamFarmCandidates)
          .where(eq(schema.scamFarmCandidates.candidateId, candidateId))
          .limit(1)
      )[0];
      if (rowDb) {
        const did = await writeScamFarmToAtlas(c, toAtlasRow(rowDb), { dryRun: false });
        if (did) {
          wroteToAtlas += 1;
        }
      }
    }
  }

  const nDismiss = c.dryRun ? 0 : await dismissStale(c, m);
  m(
    `run: sync_fund=${sync.length} rug=${rug.length} orch=${orch.length} | upserted=${candidatesUpserted} confirmed=${candidatesConfirmed} atlas=${wroteToAtlas} dismiss=${nDismiss} rpc=${rpcCounters.calls} dry=${c.dryRun} write_atlas=${c.writeAtlas}`,
  );

  const out: RunMetrics = {
    syncFundHits: sync.length,
    rugCohortHits: rug.length,
    orchestrationHits: orch.length,
    candidatesUpserted,
    candidatesConfirmed,
    wroteToAtlas,
    dismissedStale: nDismiss,
    rpcCalls: rpcCounters.calls,
    dryRun: c.dryRun,
    writeAtlas: c.writeAtlas,
  };
  log.info(out, 'scam-farm run summary');
  return out;
}
