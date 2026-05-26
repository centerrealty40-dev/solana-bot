import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../../core/db/client.js';
import { child } from '../../../core/logger.js';
import { loadScamFarmGraphConfig } from './config.js';
import { queryFlowsAmongSeeds } from './flow-among-seeds.js';
import {
  applyCexHintTag,
  applyRelayTag,
  applySinkTreasuryTags,
  applyTemporalTag,
  persistFarmMetaMemberTags,
  replaceMetaCandidates,
  replaceMetaMembers,
  resolveCandidateIdsForWallets,
  upsertMetaClusterRecord,
} from './persist-meta.js';
import { queryRelayHubs } from './relay.js';
import { loadSeedWalletAddresses } from './seeds.js';
import { queryTemporalBuyBursts } from './temporal-cohort.js';
import {
  mergeSinkHits,
  querySeedToSinkEdges,
  querySinksFromSeeds,
  querySinksWide,
} from './treasury-sink.js';
import { UnionFind } from './union-find.js';

const log = child('scam-farm-graph');

export type GraphRunMetrics = {
  enabled: boolean;
  dryRun: boolean;
  seeds: number;
  sinksNarrow: number;
  sinksWide: number;
  sinksMerged: number;
  sinkEdges: number;
  seedFlowEdges: number;
  metaClusters: number;
  relayHits: number;
  temporalWalletTags: number;
  cexHints: number;
};

export async function runScamFarmGraphPass(): Promise<GraphRunMetrics> {
  const cfg = loadScamFarmGraphConfig();
  const z: GraphRunMetrics = {
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    seeds: 0,
    sinksNarrow: 0,
    sinksWide: 0,
    sinksMerged: 0,
    sinkEdges: 0,
    seedFlowEdges: 0,
    metaClusters: 0,
    relayHits: 0,
    temporalWalletTags: 0,
    cexHints: 0,
  };

  if (!cfg.enabled) {
    log.info(z, 'scam-farm-graph skipped (disabled)');
    return z;
  }

  if (cfg.statementTimeoutMs > 0) {
    await db.execute(sql.raw(`SET statement_timeout TO ${cfg.statementTimeoutMs}`));
  }

  const exclude = [...cfg.excludeTargets];

  const seeds = await loadSeedWalletAddresses(db, cfg);
  z.seeds = seeds.length;

  const narrow = await querySinksFromSeeds(db, cfg, seeds, exclude);
  z.sinksNarrow = narrow.length;

  const wide = cfg.sinkWideMode ? await querySinksWide(db, cfg, exclude) : [];
  z.sinksWide = wide.length;

  const merged = mergeSinkHits(narrow, wide);
  z.sinksMerged = merged.length;

  const sinkTargets = merged.map((m) => m.targetWallet);

  for (const hit of merged) {
    if (hit.nSources >= cfg.treasuryMinSources) {
      await applySinkTreasuryTags(cfg, hit, 'treasury');
    } else if (hit.nSources >= cfg.sinkMinSources) {
      await applySinkTreasuryTags(cfg, hit, 'sink');
    } else if (cfg.sinkWideMode && hit.nSources >= cfg.sinkWideMinSources) {
      await applySinkTreasuryTags(cfg, hit, 'sink');
    }
  }

  const pairs = await querySeedToSinkEdges(db, cfg, seeds, sinkTargets);
  z.sinkEdges = pairs.length;

  const uf = new UnionFind();
  for (const p of pairs) {
    uf.union(p.source, p.target);
  }

  if (cfg.metaFlowEdges && seeds.length >= 2) {
    const seedPairs = await queryFlowsAmongSeeds(db, cfg, seeds);
    z.seedFlowEdges = seedPairs.length;
    for (const p of seedPairs) {
      uf.union(p.source, p.target);
    }
  }

  const sinkSet = new Set(sinkTargets);
  const seedSet = new Set(seeds);

  const comps = uf.components();
  for (const [, members] of comps) {
    if (members.size < cfg.metaMinWallets) continue;

    const wallets = [...members];
    const fingerprint = createHash('sha256').update(wallets.sort().join('|'), 'utf8').digest('hex');

    const roles = new Map<string, string>();
    for (const w of wallets) {
      if (sinkSet.has(w)) roles.set(w, 'sink');
      else if (seedSet.has(w)) roles.set(w, 'operator');
      else roles.set(w, 'unknown');
    }

    const candidateIds = await resolveCandidateIdsForWallets(wallets);
    const label = `farm_meta ${fingerprint.slice(0, 10)}…`;

    if (!cfg.dryRun) {
      const metaId = await upsertMetaClusterRecord(fingerprint, label, cfg.confidenceMetaMember, {
        phase: 'B2',
        walletCount: wallets.length,
        sinkEdgePairs: pairs.length,
        candidateLinks: candidateIds.length,
      });
      await replaceMetaMembers(
        metaId,
        wallets.map((w) => ({ wallet: w, role: roles.get(w) ?? 'unknown' })),
      );
      await replaceMetaCandidates(metaId, candidateIds);
      await persistFarmMetaMemberTags(cfg, metaId, wallets, roles, candidateIds);
    }
    z.metaClusters += 1;
  }

  const hubCandidates = [...new Set([...seeds, ...sinkTargets])];
  const relays = await queryRelayHubs(db, cfg, hubCandidates);
  z.relayHits = relays.length;
  for (const r of relays) {
    await applyRelayTag(cfg, r.hub, r.nIn, r.nOut);
  }

  const temporalHits = await queryTemporalBuyBursts(db, cfg);
  const seenTemporal = new Set<string>();
  for (const t of temporalHits) {
    const key = `${t.wallet}|${t.mint}|${t.tminIso}`;
    if (seenTemporal.has(key)) continue;
    seenTemporal.add(key);
    await applyTemporalTag(cfg, t.wallet, t.mint, t.tminIso);
    z.temporalWalletTags += 1;
  }

  if (cfg.cexDepositAllowlist.length > 0) {
    const allow = new Set(cfg.cexDepositAllowlist);
    for (const hit of merged) {
      if (allow.has(hit.targetWallet)) {
        await applyCexHintTag(cfg, hit.targetWallet, 'cex_allowlist_match');
        z.cexHints += 1;
      }
    }
  }

  log.info(z, 'scam-farm-graph summary');
  return z;
}
