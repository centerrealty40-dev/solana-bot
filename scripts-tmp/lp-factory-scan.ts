import 'dotenv/config';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) { console.error('HELIUS_API_KEY missing'); process.exit(1); }

const PAYOUT = 'HuYXn6duVnoRHXe7KqCbLUMB8ryDrynBczD1bvqPTLYn';

async function fetchPage(before?: string) {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${PAYOUT}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY!);
  u.searchParams.set('limit', '100');
  if (before) u.searchParams.set('before', before);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Helius ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any[]>;
}

async function main() {
  const gasOutflows = new Map<string, { sol: number; txs: number; first: number; last: number }>();
  let totalTxs = 0;
  let cursor: string | undefined = undefined;

  for (let page = 0; page < 10; page++) {
    const txs = await fetchPage(cursor);
    if (!txs.length) break;
    totalTxs += txs.length;
    for (const tx of txs) {
      const transfers = tx.nativeTransfers ?? [];
      for (const t of transfers) {
        if (t.fromUserAccount !== PAYOUT) continue;
        if (t.amount >= 1_000_000_000 || t.amount < 1_000_000) continue;
        const sol = t.amount / 1e9;
        const prev = gasOutflows.get(t.toUserAccount) ?? { sol: 0, txs: 0, first: tx.timestamp, last: 0 };
        prev.sol += sol;
        prev.txs += 1;
        prev.first = Math.min(prev.first, tx.timestamp);
        prev.last = Math.max(prev.last, tx.timestamp);
        gasOutflows.set(t.toUserAccount, prev);
      }
    }
    cursor = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
  }

  console.log(`Просканировано транзакций payout: ${totalTxs}`);
  console.log(`Уникальных получателей газа (0.001-1 SOL): ${gasOutflows.size}\n`);

  const sorted = [...gasOutflows.entries()].sort((a, b) => b[1].last - a[1].last);
  console.log('Свежие LP-owner кандидаты:');
  console.log('Wallet                                          SOL    Txs   Возраст');
  for (const [w, info] of sorted.slice(0, 60)) {
    const hoursAgo = Math.round((Date.now() / 1000 - info.last) / 3600);
    const lifespanMin = Math.round((info.last - info.first) / 60);
    console.log(`  ${w}  ${info.sol.toFixed(3).padStart(6)}  ${String(info.txs).padStart(3)}   ${hoursAgo}h ago  (lifespan ${lifespanMin}m)`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
