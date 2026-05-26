#!/usr/bin/env node
/**
 * One-shot: create dedicated micro keypair for live-oscar simulate/live if missing.
 * Run on VPS as salpha: node scripts/ops/ensure-live-micro-keypair.mjs
 */
import { Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || path.join(process.cwd(), 'data/live/live-oscar-micro.keypair.json');

if (fs.existsSync(out)) {
  const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
  const secret = Uint8Array.from(raw);
  const kp = Keypair.fromSecretKey(secret);
  process.stdout.write(`exists ${out}\npub ${kp.publicKey.toBase58()}\n`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const k = Keypair.generate();
fs.writeFileSync(out, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
process.stdout.write(`created ${out}\npub ${k.publicKey.toBase58()}\n`);
