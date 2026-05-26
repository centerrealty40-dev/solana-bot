#!/usr/bin/env node
/**
 * Print base58 pubkey from a Solana keypair file (JSON byte array or single-line base58).
 * Usage: node scripts/ops/print-wallet-pubkey.mjs /path/to/keypair.json
 */
import fs from 'node:fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const p = process.argv[2];
if (!p) {
  console.error('usage: print-wallet-pubkey.mjs <path>');
  process.exit(2);
}
const raw = fs.readFileSync(p, 'utf8').trim();
let kp;
if (raw.startsWith('[')) {
  kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
} else {
  kp = Keypair.fromSecretKey(bs58.decode(raw));
}
console.log(kp.publicKey.toBase58());
