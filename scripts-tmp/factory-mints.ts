import 'dotenv/config';
const HELIUS_KEY = process.env.HELIUS_API_KEY!;
const PAYOUT = 'HuYXn6duVnoRHXe7KqCbLUMB8ryDrynBczD1bvqPTLYn';

async function fetchHistory(addr: string, before?: string, limit = 100) {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY);
  u.searchParams.set('limit', String(limit));
  if (before) u.searchParams.set('before', before);
  const res = await fetch(u.toString());
  if (!res.ok) return [];
  return res.json() as Promise<any[]>;
}

async function main() {
  const sybils = new Set<string>();
  let cursor: string | undefined;
  for (let p = 0; p < 30; p++) {
    const txs = await fetchHistory(PAYOUT, cursor);
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
  console.log(`Sybils to scan: ${sybils.size}\n`);

  const mintCounts = new Map<string, { buyers: Set<string>; firstTs: number; lastTs: number; collector?: string }>();
  let scanned = 0;
  for (const sybil of sybils) {
    scanned++;
    if (scanned % 25 === 0) process.stderr.write(`scanned ${scanned}/${sybils.size}, mints found ${mintCounts.size}\n`);
    const hist = await fetchHistory(sybil, undefined, 10);
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
  }

  console.log('\n=== ЦЕЛЕВЫЕ ТОКЕНЫ ФАБРИКИ ===');
  console.log('mint                                          buyers  collector       window');
  const sorted = [...mintCounts.entries()].sort((a, b) => b[1].buyers.size - a[1].buyers.size);
  for (const [mint, info] of sorted) {
    const winMin = Math.round((info.lastTs - info.firstTs) / 60);
    console.log(`  ${mint}  ${String(info.buyers.size).padStart(4)}   ${(info.collector ?? '-').slice(0,12).padEnd(13)}  ${winMin}m`);
    console.log(`    https://dexscreener.com/solana/${mint}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
