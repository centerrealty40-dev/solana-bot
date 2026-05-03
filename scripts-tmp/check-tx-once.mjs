/**
 * One-off: confirm whether a signature landed on-chain (uses SA_RPC_HTTP_URL from cwd .env).
 *   cd /opt/solana-alpha && node scripts-tmp/check-tx-once.mjs <signature>
 */
import 'dotenv/config';

const sig = process.argv[2];
const rpc = process.env.SA_RPC_HTTP_URL?.trim() || process.env.QUICKNODE_HTTP_URL?.trim();
if (!sig) {
  console.error('usage: node check-tx-once.mjs <base58Signature>');
  process.exit(1);
}
if (!rpc) {
  console.error('SA_RPC_HTTP_URL / QUICKNODE_HTTP_URL missing');
  process.exit(1);
}

async function rpcCall(method, params) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const st = await rpcCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
const s0 = Array.isArray(st?.value) ? st.value[0] : null;

const tx = await rpcCall('getTransaction', [
  sig,
  { encoding: 'json', maxSupportedTransactionVersion: 0 },
]);

console.log(
  JSON.stringify(
    {
      signature: sig,
      confirmationStatus: s0?.confirmationStatus ?? null,
      err: s0?.err ?? null,
      slot: tx?.slot ?? null,
      metaErr: tx?.meta?.err ?? null,
      landed: tx != null && tx.meta?.err === null,
    },
    null,
    2,
  ),
);
