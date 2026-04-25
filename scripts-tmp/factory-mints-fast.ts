import 'dotenv/config';
const HELIUS_KEY = process.env.HELIUS_API_KEY!;
const PAYOUT = 'HuYXn6duVnoRHXe7KqCbLUMB8ryDrynBczD1bvqPTLYn';

async function fetchHistory(addr: string, limit = 5) {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY);
  u.searchParams.set('limit', String(limit));
  try {
    const res = await fetch(u.toString());
    if (!res.ok) return [];
    return await res.json() as any[];
  } catch { return []; }
}

async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const sybils = new Set<string>();
  let cursor: string | undefined;
  for (let p = 0; p < 5; p++) {
    const u = new URL(`https://api.helius.xyz/v0/addresses/${PAYOUT}/transactions`);
    u.searchParams.set('api-key', HELIUS_KEY);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('before', cursor);
    const txs = await (await fetch(u)).json() as any[];
    if (!txs.length) break;
    for (const tx of txs) {
      for (const t of tx.nativeTransfers ?? []) {
        if (t.fromUserAccount === PAYOUT && t.amount >= 1_000_000 && t.amount < 10_000_000) {
          sybils.add(t.toUserAccount);
        }
      }
    }
    cursor = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
  }
  
  const sybilList = [...sybils].slice(0, 80);
  console.log(`Sybils to scan (parallel x8): ${sybilList.length}\n`);

  const mintCounts = new Map<string, { buyers: Set<string>; firstTs: number; lastTs: number; collector?: string }>();
  let done = 0;

  await pMap(sybilList, 8, async (sybil) => {
    const hist = await fetchHistory(sybil, 5);
    for (const tx of hist) {
      const swap = tx.events?.swap;
      const out = swap?.tokenOutputs?.[0];
      if (out?.mint && out.mint !== 'So11111111111111111111111111111111111111112') {
        const m = mintCounts.get(out.mint) ?? { buyers: new Set<string>(), firstTs: tx.timestamp, lastTs: 0 };
        m.buyers.add(sybil);
        m.firstTs = Math.min(m.firstTs, tx.timestamp);
        m.lastTs = Math.max(m.lastTs, tx.timestamp);
        for (const tt of tx.tokenTransfers ?? []) {
          if (tt.mint === out.mint && tt.fromUserAccount === sybil && tt.toUserAccount !== sybil) {
            m.collector = tt.toUserAccount;
          }
        }
        mintCounts.set(out.mint, m);
      }
    }
    done++;
    if (done % 10 === 0) process.stderr.write(`done ${done}/${sybilList.length}, mints=${mintCounts.size}\n`);
  });

  console.log('\n=== ЦЕЛЕВЫЕ ТОКЕНЫ ФАБРИКИ ===');
  const sorted = [...mintCounts.entries()].sort((a, b) => b[1].buyers.size - a[1].buyers.size);
  for (const [mint, info] of sorted) {
    const winMin = Math.round((info.lastTs - info.firstTs) / 60);
    const ago = Math.round((Date.now()/1000 - info.lastTs) / 3600);
    console.log(`  ${mint}  buyers=${String(info.buyers.size).padStart(3)}  collector=${(info.collector ?? '-').slice(0,12)}  attack_window=${winMin}m  ${ago}h_ago`);
    console.log(`    https://dexscreener.com/solana/${mint}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
