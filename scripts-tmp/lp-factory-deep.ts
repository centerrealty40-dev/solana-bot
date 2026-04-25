import 'dotenv/config';

const HELIUS_KEY = process.env.HELIUS_API_KEY!;
const PAYOUT = 'HuYXn6duVnoRHXe7KqCbLUMB8ryDrynBczD1bvqPTLYn';

async function fetchHistory(addr: string, before?: string, limit = 100) {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', HELIUS_KEY);
  u.searchParams.set('limit', String(limit));
  if (before) u.searchParams.set('before', before);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Helius ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any[]>;
}

async function main() {
  const recipients = new Map<string, { sol: number; txs: number; first: number; last: number }>();
  const amountBuckets = new Map<number, number>();
  let totalTxs = 0;
  let cursor: string | undefined;
  const PAGES = 30;

  for (let page = 0; page < PAGES; page++) {
    const txs = await fetchHistory(PAYOUT, cursor);
    if (!txs.length) break;
    totalTxs += txs.length;
    for (const tx of txs) {
      for (const t of tx.nativeTransfers ?? []) {
        if (t.fromUserAccount !== PAYOUT) continue;
        if (t.amount >= 1_000_000_000 || t.amount < 100_000) continue;
        const sol = t.amount / 1e9;
        const prev = recipients.get(t.toUserAccount) ?? { sol: 0, txs: 0, first: tx.timestamp, last: 0 };
        prev.sol += sol;
        prev.txs += 1;
        prev.first = Math.min(prev.first, tx.timestamp);
        prev.last = Math.max(prev.last, tx.timestamp);
        recipients.set(t.toUserAccount, prev);
        const bucketKey = Math.round(t.amount / 1e6);
        amountBuckets.set(bucketKey, (amountBuckets.get(bucketKey) ?? 0) + 1);
      }
    }
    cursor = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
    process.stderr.write(`page ${page + 1}/${PAGES} done, txs=${totalTxs}, recipients=${recipients.size}\n`);
  }

  console.log(`\n=== МАСШТАБ ===`);
  console.log(`Транзакций отсканировано:       ${totalTxs}`);
  console.log(`Уникальных получателей газа:    ${recipients.size}`);

  console.log(`\n=== РАСПРЕДЕЛЕНИЕ СУММ (mSOL → кол-во tx) ===`);
  const sortedBuckets = [...amountBuckets.entries()].sort((a, b) => b[1] - a[1]);
  for (const [mSol, count] of sortedBuckets.slice(0, 15)) {
    console.log(`  ${(mSol / 1000).toFixed(4)} SOL  →  ${count} tx`);
  }

  const sample = [...recipients.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, 5);
  console.log(`\n=== ЧТО КУПИЛИ ТОП-5 СВЕЖИХ ПОЛУЧАТЕЛЕЙ ===`);
  for (const [w, info] of sample) {
    console.log(`\n--- ${w}  (gas ${info.sol.toFixed(4)} SOL × ${info.txs}) ---`);
    try {
      const hist = await fetchHistory(w, undefined, 10);
      console.log(`  Всего tx у этого кошелька: ${hist.length}`);
      for (const tx of hist.slice(0, 5)) {
        const swap = tx.events?.swap;
        if (swap) {
          const tokenIn = swap.tokenInputs?.[0];
          const tokenOut = swap.tokenOutputs?.[0];
          console.log(`  SWAP  in=${tokenIn?.mint?.slice(0,8) ?? '-'} out=${tokenOut?.mint?.slice(0,8) ?? '-'}  ${tx.description ?? ''}`);
        } else {
          console.log(`  ${tx.type}  ${tx.description?.slice(0, 80) ?? ''}`);
        }
      }
    } catch (e: any) {
      console.log(`  err: ${e.message}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
