/**
 * One-shot: sell all non-stable SPL balances on a copy-trader wallet to USDC.
 *
 *   npx tsx src/scripts/copy-trader-wallet-flatten.ts --lane=8zkg
 *   npx tsx src/scripts/copy-trader-wallet-flatten.ts --lane=mirror
 *
 * Does NOT touch mild-dip / live-oscar-micro wallet.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadCopyTraderConfig } from '../copytrader/config.js';
import { executeCopySell } from '../copytrader/executor.js';
import { resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const KEEP = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'So11111111111111111111111111111111111111112', // WSOL
]);

type Lane = '8zkg' | 'mirror';

function parseLane(): Lane {
  const arg = process.argv.find((a) => a.startsWith('--lane='))?.slice('--lane='.length);
  if (arg === '8zkg' || arg === 'mirror') return arg;
  throw new Error('usage: copy-trader-wallet-flatten.ts --lane=8zkg|mirror');
}

function loadKeypair(secretPath: string): Keypair {
  const raw = fs.readFileSync(secretPath, 'utf8').trim();
  if (raw.startsWith('[')) {
    const j = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(j));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

function applyLaneEnv(lane: Lane): { label: string; secret: string; pubkey: string } {
  const root = process.cwd();
  if (lane === '8zkg') {
    const secret = path.join(root, 'data/live/copy-8zkg.keypair.json');
    const pubkey = 'FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX';
    process.env.COPY_TRADER_APP_NAME = 'copy-trader-8zkg-flatten';
    process.env.COPY_TRADER_WALLET_SECRET = secret;
    process.env.COPY_TRADER_WALLET_PUBKEY = pubkey;
    process.env.COPY_TRADER_TARGET_WALLET = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';
    process.env.COPY_TRADER_JOURNAL_PATH = path.join(root, 'data/copytrader-8zkg/journal.jsonl');
    process.env.COPY_TRADER_STATE_PATH = path.join(root, 'data/copytrader-8zkg/state.json');
    process.env.COPY_TRADER_QUOTE_MINT = 'USDC';
    process.env.COPY_TRADER_SHARED_OSCAR_WALLET = '0';
    process.env.COPY_TRADER_STRICT_ISOLATION = '1';
    process.env.COPY_TRADER_EXECUTION_MODE = 'live';
    process.env.COPY_TRADER_MIN_FEE_SOL_RESERVE = '0.02';
    return { label: '8zkg', secret, pubkey };
  }
  const secret = path.join(root, 'data/live/mcs-wallet.json');
  const pubkey = '2fMzAm6aTCAPrXjamCLRbjLRxEqrcD7zLdN2wNdaL7Ps';
  process.env.COPY_TRADER_APP_NAME = 'copy-trader-8zkg-mirror-flatten';
  process.env.COPY_TRADER_WALLET_SECRET = secret;
  process.env.COPY_TRADER_WALLET_PUBKEY = pubkey;
  process.env.COPY_TRADER_TARGET_WALLET = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';
  process.env.COPY_TRADER_JOURNAL_PATH = path.join(root, 'data/copytrader-8zkg-mirror/journal.jsonl');
  process.env.COPY_TRADER_STATE_PATH = path.join(root, 'data/copytrader-8zkg-mirror/state.json');
  process.env.COPY_TRADER_QUOTE_MINT = 'USDC';
  process.env.COPY_TRADER_SHARED_OSCAR_WALLET = '0';
  process.env.COPY_TRADER_STRICT_ISOLATION = '1';
  process.env.COPY_TRADER_EXECUTION_MODE = 'live';
  process.env.COPY_TRADER_MIN_FEE_SOL_RESERVE = '0.02';
  return { label: 'mirror', secret, pubkey };
}

async function listSellMints(rpcUrl: string, owner: PublicKey): Promise<string[]> {
  const conn = new Connection(rpcUrl, 'confirmed');
  const mints: string[] = [];
  for (const programId of [TOKEN, TOKEN2022]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { account } of res.value) {
      const info = account.data.parsed.info as {
        mint: string;
        tokenAmount: { amount: string };
      };
      if (KEEP.has(info.mint)) continue;
      if (!/^\d+$/.test(info.tokenAmount.amount) || BigInt(info.tokenAmount.amount) <= 0n) continue;
      mints.push(info.mint);
    }
  }
  return [...new Set(mints)];
}

async function main(): Promise<void> {
  const lane = parseLane();
  const meta = applyLaneEnv(lane);
  const kp = loadKeypair(meta.secret);
  if (kp.publicKey.toBase58() !== meta.pubkey) {
    throw new Error(`keypair pubkey mismatch for ${lane}: ${kp.publicKey.toBase58()} != ${meta.pubkey}`);
  }
  const cfg = loadCopyTraderConfig();
  const rpc = cfg.rpcUrl || resolveSolanaRpcUrl() || '';
  if (!rpc) throw new Error('no RPC URL');

  const mints = await listSellMints(rpc, kp.publicKey);
  console.log(`[flatten-${meta.label}] wallet=${meta.pubkey} candidates=${mints.length}`);

  let ok = 0;
  let fail = 0;
  for (const mint of mints) {
    const res = await executeCopySell({
      cfg,
      mint,
      symbol: mint.slice(0, 8),
      entryPriceUsd: 1,
      exitPriceUsd: 1,
      sizeUsd: 1,
      fraction: 1,
      leaderSignature: `flatten_${lane}_${Date.now()}`,
      sellDelayMs: 0,
    });
    if (res.ok) {
      ok += 1;
      console.log(`[flatten-${meta.label}] SOLD ${mint.slice(0, 8)}… px=${res.priceUsd} sig=${res.signature ?? ''}`);
    } else {
      fail += 1;
      console.warn(`[flatten-${meta.label}] FAIL ${mint.slice(0, 8)}… ${res.reason}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const left = await listSellMints(rpc, kp.publicKey);
  console.log(
    JSON.stringify(
      { lane: meta.label, soldOk: ok, soldFail: fail, remainingNonStable: left.length, remaining: left },
      null,
      2,
    ),
  );
  if (left.length > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
