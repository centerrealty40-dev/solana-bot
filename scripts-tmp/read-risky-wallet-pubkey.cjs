/**
 * One-shot: print base58 pubkey for live-oscar-risky keypair (JSON array or base58 line).
 * Usage (on VPS): cd /opt/solana-alpha && node scripts-tmp/read-risky-wallet-pubkey.cjs
 */
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

const keyPath = path.join(__dirname, '..', 'data', 'live', 'live-oscar-risky.keypair.json');
const content = fs.readFileSync(keyPath, 'utf8').replace(/^\uFEFF/, '').trim();
if (!content) throw new Error('empty key file');
let kp;
if (content.startsWith('[')) {
  const a = JSON.parse(content);
  kp = Keypair.fromSecretKey(Uint8Array.from(a.map(Number)));
} else {
  kp = Keypair.fromSecretKey(bs58.decode(content));
}
console.log(kp.publicKey.toBase58());
