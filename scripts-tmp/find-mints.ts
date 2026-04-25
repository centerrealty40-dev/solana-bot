import 'dotenv/config';
const HELIUS_KEY = process.env.HELIUS_API_KEY!;
const CREATOR = 'HuYXn6duVnoRHXe7KqCbLUMB8ryDrynBczD1bvqPTLYn';

async function main() {
  let cursor: string | undefined;
  const mintsCreated = new Map<string, { ts: number; symbol?: string }>();
  for (let page = 0; page < 20; page++) {
    const u = new URL(`https://api.helius.xyz/v0/addresses/${CREATOR}/transactions`);
    u.searchParams.set('api-key', HELIUS_KEY);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('before', cursor);
    const txs = await (await fetch(u)).json() as any[];
    if (!txs.length) break;
    for (const tx of txs) {
      const isMint = tx.type === 'TOKEN_MINT' || tx.type === 'CREATE_POOL' || 
                     (tx.description ?? '').toLowerCase().includes('mint') ||
                     (tx.description ?? '').toLowerCase().includes('created');
      const mints = (tx.tokenTransfers ?? []).map((t: any) => t.mint);
      for (const m of mints) {
        if (m && !mintsCreated.has(m) && tx.feePayer === CREATOR) {
          mintsCreated.set(m, { ts: tx.timestamp });
        }
      }
      if (isMint) console.log(`[mint candidate] ${tx.signature} type=${tx.type} desc=${(tx.description ?? '').slice(0,80)}`);
    }
    cursor = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
  }
  console.log(`\nTotal unique mints touched: ${mintsCreated.size}`);
  const sorted = [...mintsCreated.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 30);
  for (const [m, info] of sorted) {
    const ago = Math.round((Date.now()/1000 - info.ts) / 3600);
    console.log(`  ${m}  ${ago}h ago    https://dexscreener.com/solana/${m}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
