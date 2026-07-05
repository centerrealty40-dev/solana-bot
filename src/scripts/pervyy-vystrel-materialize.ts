/**
 * Batch materialize worker — vol-auth, organic flow, early cluster map (PR2).
 * PM2: pervyy-vystrel-materialize (DISABLED by default, 15m loop when enabled).
 */

import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';
import {
  buildEarlyClusterMapFromSwaps,
  buildWalletClusterMapForSwaps,
  evaluateClusterDumpShadow,
  fetchMintSwapsForClusterMap,
} from '../papertrader/discovery/mint-early-cluster-map.js';
import {
  evaluateOrganicFlowGate,
  fetchOrganicFlowBuyersFromPg,
  organicFlowThresholdsFromConfig,
} from '../papertrader/discovery/mint-organic-flow-gate.js';
import {
  computeVolumeAuthenticitySnapshot,
  fetchPriorBuyerWallets,
  fetchVolAuthSwapsFromPg,
  volumeAuthenticityThresholdsFromConfig,
} from '../papertrader/discovery/mint-volume-authenticity.js';
import {
  type PervyyVystrelMaterializedCacheFile,
  type PervyyVystrelMintMaterialized,
  writePervyyVystrelMaterializedCache,
} from '../papertrader/discovery/pervyy-vystrel-snapshot-cache.js';
import { loadPervyyVystrelConfig } from '../papertrader/live-oscar-pervyy-vystrel-config.js';

const log = child('pervyy-vystrel-materialize');

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function parseMintList(): string[] {
  const raw = process.env.PERVYY_VYSTREL_MATERIALIZE_MINTS?.trim();
  if (raw) {
    return [...new Set(raw.split(/[,\s]+/).map((m) => m.trim()).filter(Boolean))];
  }
  return [];
}

async function discoverWatchlistMints(limit: number): Promise<string[]> {
  const pv = loadPervyyVystrelConfig();
  const rows = (await db.execute(dsql.raw(`
    SELECT base_mint AS mint
    FROM pumpswap_pair_snapshots
    WHERE ts >= now() - interval '${pv.watchTtlHours} hours'
      AND COALESCE(market_cap_usd, 0) >= ${pv.anchorMinMcapUsd}
      AND COALESCE(market_cap_usd, 0) <= ${pv.anchorMaxMcapUsd * 4}
      AND COALESCE(volume_1h, 0) >= ${pv.minVol1hUsd * 0.5}
    GROUP BY base_mint
    ORDER BY MAX(ts) DESC
    LIMIT ${Math.max(1, Math.min(100, limit))}
  `))) as unknown as Array<{ mint: string }>;
  return rows.map((r) => r.mint);
}

async function materializeMint(mint: string): Promise<PervyyVystrelMintMaterialized> {
  const pv = loadPervyyVystrelConfig();
  const volThresholds = volumeAuthenticityThresholdsFromConfig(pv);
  const organicThresholds = organicFlowThresholdsFromConfig(pv);
  const windowHours = pv.volAuthWindowHours;

  const [volSwaps, priorBuyers, organicBuyers, clusterSwaps] = await Promise.all([
    fetchVolAuthSwapsFromPg(mint, windowHours),
    fetchPriorBuyerWallets(mint, windowHours),
    fetchOrganicFlowBuyersFromPg(mint, windowHours),
    fetchMintSwapsForClusterMap(mint, Math.max(24, pv.watchTtlHours)),
  ]);

  const volAuth = computeVolumeAuthenticitySnapshot({
    mint,
    windowHours,
    swaps: volSwaps,
    priorBuyerWallets: priorBuyers,
    thresholds: volThresholds,
  });

  const organicFlow = evaluateOrganicFlowGate({
    mint,
    windowHours,
    buyers: organicBuyers,
    thresholds: organicThresholds,
  });

  const wallets = [...new Set(clusterSwaps.map((s) => s.wallet))];
  const clusterLookup = await buildWalletClusterMapForSwaps(wallets);
  const clusterMap = buildEarlyClusterMapFromSwaps({
    mint,
    swaps: clusterSwaps,
    earlyBuyWindowSec: pv.earlyBuyWindowSec,
    walletClusters: clusterLookup,
  });

  if (clusterSwaps.length === 0) {
    log.warn({ mint }, 'materialize: no swaps in PG — cluster attribution blocked (U3 ingest gap)');
  }

  const dumpWindowHours = 0.5;
  const dumpCutoffMs = Date.now() - dumpWindowHours * 3600 * 1000;
  const dumpSells = clusterSwaps.filter(
    (s) => String(s.side).toLowerCase() === 'sell' && s.blockTimeMs >= dumpCutoffMs,
  );
  const clusterDumpShadow = evaluateClusterDumpShadow({
    mint,
    clusterMap,
    dumpSells,
    clusterSellRatioMin: pv.clusterSellRatioMin,
    clusterMinUniqueSellers: pv.clusterMinUniqueSellers,
    retailPanicMax: pv.retailPanicMax,
    walletClusters: clusterLookup,
  });

  return { volAuth, organicFlow, clusterMap, clusterDumpShadow };
}

export async function runPervyyVystrelMaterializeOnce(): Promise<PervyyVystrelMaterializedCacheFile> {
  const explicit = parseMintList();
  const mints =
    explicit.length > 0
      ? explicit
      : await discoverWatchlistMints(Number(process.env.PERVYY_VYSTREL_MATERIALIZE_LIMIT || 30));

  const out: Record<string, PervyyVystrelMintMaterialized> = {};
  for (const mint of mints) {
    try {
      out[mint] = await materializeMint(mint);
      log.info({ mint, volAuthPass: out[mint]!.volAuth?.authenticPass }, 'materialized mint');
    } catch (e) {
      log.warn({ mint, err: (e as Error).message }, 'materialize mint failed');
    }
  }

  const file: PervyyVystrelMaterializedCacheFile = {
    computedAtMs: Date.now(),
    ttlSec: Number(process.env.PERVYY_VYSTREL_MATERIALIZE_TTL_SEC || 120),
    mints: out,
  };
  writePervyyVystrelMaterializedCache(file);
  log.info({ mintCount: Object.keys(out).length }, 'cache written');
  return file;
}

async function main(): Promise<void> {
  const enabled = envBool(process.env.PERVYY_VYSTREL_MATERIALIZE_ENABLED, false);
  if (!enabled) {
    log.info('PERVYY_VYSTREL_MATERIALIZE_ENABLED=0 — idle (avoid PM2 restart loop on exit)');
    await new Promise<void>(() => {
      /* hang — PM2 autorestart would loop on process.exit(0) */
    });
    return;
  }

  const intervalMin = Math.max(5, Number(process.env.PERVYY_VYSTREL_MATERIALIZE_INTERVAL_MIN || 15));
  const intervalMs = intervalMin * 60 * 1000;

  const tick = async () => {
    try {
      await runPervyyVystrelMaterializeOnce();
    } catch (e) {
      log.error({ err: (e as Error).message }, 'materialize tick failed');
    }
  };

  await tick();
  setInterval(tick, intervalMs);
  log.info({ intervalMin }, 'materialize loop started');
}

const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('pervyy-vystrel-materialize.ts') ||
    process.argv[1].endsWith('pervyy-vystrel-materialize.js'));

if (isMain) {
  main().catch((e) => {
    log.error({ err: (e as Error).message }, 'fatal');
    process.exit(1);
  });
}
