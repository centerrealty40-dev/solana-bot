import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import { child } from '../../core/logger.js';

const log = child('cluster');

/**
 * Detect entities (groups of wallets likely operated by the same person/team) using:
 *   1. Shared funding source (parent wallet that sent first SOL/USDC to both)
 *   2. Temporal correlation of buys: pairs of wallets that bought the same token within 30s
 *
 * We build an undirected weighted graph, then run Louvain community detection.
 * The result is a stable cluster id per wallet.
 *
 * Returns map wallet -> cluster_id ("c<n>" for clusters of size>=2, null for singletons).
 */
export async function computeClusters(
  wallets: string[],
  windowDays = 30,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (wallets.length === 0) return result;

  const since = new Date(Date.now() - windowDays * 86_400_000);
  const g = new Graph({ multi: false, type: 'undirected' });
  for (const w of wallets) g.addNode(w);

  // Edge type 1: shared funding source
  const fundingRows = await db.execute(dsql`
    SELECT a.address AS w1, b.address AS w2
    FROM wallets a
    JOIN wallets b
      ON a.funding_source = b.funding_source
     AND a.funding_source IS NOT NULL
     AND a.address < b.address
    WHERE a.address = ANY(${dsql.raw(arrayLiteral(wallets))})
      AND b.address = ANY(${dsql.raw(arrayLiteral(wallets))})
    LIMIT 50000
  `);
  let funded = 0;
  for (const r of fundingRows as unknown as Array<{ w1: string; w2: string }>) {
    if (g.hasNode(r.w1) && g.hasNode(r.w2)) {
      addOrIncWeight(g, r.w1, r.w2, 3);
      funded += 1;
    }
  }

  // Edge type 2: temporal co-buy (same base_mint, within 30 seconds)
  const coBuyRows = await db.execute(dsql`
    SELECT a.wallet AS w1, b.wallet AS w2, COUNT(*) AS n
    FROM swaps a
    JOIN swaps b
      ON a.base_mint = b.base_mint
     AND a.side = 'buy' AND b.side = 'buy'
     AND b.block_time BETWEEN a.block_time AND a.block_time + INTERVAL '30 seconds'
     AND a.wallet < b.wallet
    WHERE a.block_time >= ${since}
      AND a.wallet = ANY(${dsql.raw(arrayLiteral(wallets))})
      AND b.wallet = ANY(${dsql.raw(arrayLiteral(wallets))})
    GROUP BY a.wallet, b.wallet
    HAVING COUNT(*) >= 2
    LIMIT 50000
  `);
  let cobuys = 0;
  for (const r of coBuyRows as unknown as Array<{ w1: string; w2: string; n: bigint | number }>) {
    if (g.hasNode(r.w1) && g.hasNode(r.w2)) {
      addOrIncWeight(g, r.w1, r.w2, Number(r.n));
      cobuys += 1;
    }
  }

  log.info({ wallets: wallets.length, fundedEdges: funded, coBuyEdges: cobuys }, 'graph built');

  if (g.size === 0) {
    return result;
  }

  louvain.assign(g, { resolution: 1.0 });
  const clusterIdByCommunity = new Map<number, string>();
  let nextId = 0;
  // Compute community sizes first
  const sizes = new Map<number, number>();
  g.forEachNode((_, attrs) => {
    const c = attrs.community as number;
    sizes.set(c, (sizes.get(c) ?? 0) + 1);
  });
  g.forEachNode((node, attrs) => {
    const c = attrs.community as number;
    const sz = sizes.get(c) ?? 0;
    if (sz < 2) return; // ignore singletons
    let id = clusterIdByCommunity.get(c);
    if (!id) {
      id = `c${nextId++}`;
      clusterIdByCommunity.set(c, id);
    }
    result.set(node, id);
  });
  log.info({ clusters: clusterIdByCommunity.size, walletsInClusters: result.size }, 'clusters computed');
  return result;
}

function addOrIncWeight(g: Graph, a: string, b: string, w: number): void {
  if (g.hasEdge(a, b)) {
    const cur = (g.getEdgeAttribute(a, b, 'weight') as number | undefined) ?? 1;
    g.setEdgeAttribute(a, b, 'weight', cur + w);
  } else {
    g.addEdge(a, b, { weight: w });
  }
}

function arrayLiteral(values: string[]): string {
  return `ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::varchar[]`;
}
