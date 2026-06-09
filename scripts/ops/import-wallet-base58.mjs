#!/usr/bin/env node
/**
 * Write gitignored keypair JSON from base58 secret file (one line).
 * Usage: node scripts/ops/import-wallet-base58.mjs --in /path/to/secret.txt --out data/pumpswap-combo-follow/wallet.keypair.json
 */
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const args = process.argv.slice(2);
let inPath = '';
let outPath = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in') inPath = args[++i] ?? '';
  if (args[i] === '--out') outPath = args[++i] ?? '';
}
if (!inPath || !outPath) {
  console.error('usage: --in <base58-file> --out <wallet.keypair.json>');
  process.exit(1);
}
const secret = fs.readFileSync(inPath, 'utf8').trim();
const kp = Keypair.fromSecretKey(bs58.decode(secret));
const dir = path.dirname(outPath);
if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(Array.from(kp.secretKey)), 'utf8');
fs.chmodSync(outPath, 0o600);
console.log(JSON.stringify({ ok: true, pubkey: kp.publicKey.toBase58(), out: outPath }));
