/**
 * Inspect chain truth for a signature (fee payer, meta.err, token balance deltas).
 *   cd /opt/solana-alpha && node scripts-tmp/verify-swap-tx.mjs <sig> <optionalWalletPubkey>
 */
import 'dotenv/config';

const sig = process.argv[2];
const walletHint = process.argv[3]?.trim();
const rpc = process.env.SA_RPC_HTTP_URL?.trim();
if (!sig || !rpc) {
  console.error('usage: node verify-swap-tx.mjs <signature> [walletPubkey]');
  process.exit(1);
}

const body = (method, params) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

const txRes = await fetch(rpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body('getTransaction', [
    sig,
    { encoding: 'json', maxSupportedTransactionVersion: 0 },
  ]),
});
const txJson = await txRes.json();
const tx = txJson.result;

const stRes = await fetch(rpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]),
});
const stJson = await stRes.json();
const stRaw = stJson.result;

function unwrapStatusRow(raw) {
  if (Array.isArray(raw) && raw.length) return raw[0];
  if (raw && typeof raw === 'object' && Array.isArray(raw.value)) return raw.value[0];
  return null;
}

const row = unwrapStatusRow(stRaw);

let feePayer = null;
const keys = tx?.transaction?.message?.accountKeys;
if (Array.isArray(keys) && keys.length) {
  feePayer = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey ?? keys[0];
}

const meta = tx?.meta;
const preTb = meta?.preTokenBalances ?? [];
const postTb = meta?.postTokenBalances ?? [];

const mintOut = new Set();
for (const b of postTb) {
  if (b?.mint) mintOut.add(b.mint);
}

let walletMatch = walletHint || null;
const relevant = (walletHint
  ? [...preTb, ...postTb].filter((b) => b?.owner === walletHint)
  : [...postTb]
).slice(0, 20);

console.log(
  JSON.stringify(
    {
      signature: sig,
      present: tx != null,
      slot: tx?.slot ?? null,
      metaErr: meta?.err ?? null,
      feePayer,
      signatureStatusRow: row,
      /** How phase6-send parsed wrongly: passes whole `result` without `.value` */
      phase6Bug_shapeIsArray: Array.isArray(stRaw),
      preSolBalances: meta?.preBalances?.slice(0, 3) ?? null,
      postSolBalances: meta?.postBalances?.slice(0, 3) ?? null,
      tokenMintsTouched: [...mintOut].slice(0, 15),
      sampleTokenBalancesForWallet: walletMatch ? relevant : '(pass wallet as argv3)',
    },
    null,
    2,
  ),
);
