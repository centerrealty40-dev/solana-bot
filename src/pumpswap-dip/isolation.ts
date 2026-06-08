import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { PumpswapDipConfig } from './config.js';
import { COPY_TRADER_RISKY_WALLET_PUBKEY } from '../copytrader/isolation.js';
import { pubkeyFromWalletSecretPath } from '../copytrader/wallet-pubkey.js';

const LIVE_OSCAR_MAIN_PUBKEY = '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc';

const FORBIDDEN_PATH_FRAGMENTS = [
  'pt1-oscar-live.jsonl',
  'live-oscar-mint-whitelist',
  'live-oscar-mint-blacklist',
  'copytrader/journal.jsonl',
  'copytrader/state.json',
  'organizer-paper',
  'paper-oscar',
  'priority-fee-cache-live-oscar',
  'hl-twap/live.jsonl',
];

function norm(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').toLowerCase();
}

function pathForbidden(p: string): boolean {
  const n = norm(p);
  return FORBIDDEN_PATH_FRAGMENTS.some((frag) => n.includes(frag.toLowerCase()));
}

function readPubkeyFromKeypairFile(secretPath: string): string | null {
  try {
    return pubkeyFromWalletSecretPath(secretPath);
  } catch {
    try {
      const raw = fs.readFileSync(secretPath, 'utf8').trim();
      if (raw.startsWith('[')) {
        const j = JSON.parse(raw) as unknown;
        if (!Array.isArray(j)) return null;
        return Keypair.fromSecretKey(Uint8Array.from(j.map((n) => Number(n)))).publicKey.toBase58();
      }
      return Keypair.fromSecretKey(bs58.decode(raw)).publicKey.toBase58();
    } catch {
      return null;
    }
  }
}

/** Hard guard: pumpswap-dip must not share Oscar / copy-trader journals or wallets. */
export function assertPumpswapDipIsolation(cfg: PumpswapDipConfig): void {
  if (pathForbidden(cfg.journalPath)) {
    throw new Error(`PUMPSWAP_DIP_JOURNAL_PATH overlaps other strategies: ${cfg.journalPath}`);
  }
  if (pathForbidden(cfg.statePath)) {
    throw new Error(`PUMPSWAP_DIP_STATE_PATH overlaps other strategies: ${cfg.statePath}`);
  }

  const liveTrades = process.env.LIVE_TRADES_PATH?.trim();
  if (liveTrades && norm(cfg.journalPath) === norm(liveTrades)) {
    throw new Error('PUMPSWAP_DIP_JOURNAL_PATH must not equal LIVE_TRADES_PATH');
  }
  const copyJournal = process.env.COPY_TRADER_JOURNAL_PATH?.trim();
  if (copyJournal && norm(cfg.journalPath) === norm(copyJournal)) {
    throw new Error('PUMPSWAP_DIP_JOURNAL_PATH must not equal COPY_TRADER_JOURNAL_PATH');
  }

  const liveSecret = process.env.LIVE_WALLET_SECRET?.trim();
  const copySecret = process.env.COPY_TRADER_WALLET_SECRET?.trim();
  const dipSecret = cfg.walletSecret?.trim();
  if (dipSecret) {
    if (liveSecret && norm(liveSecret) === norm(dipSecret)) {
      throw new Error('PUMPSWAP_DIP_WALLET_SECRET must not equal LIVE_WALLET_SECRET');
    }
    if (copySecret && norm(copySecret) === norm(dipSecret)) {
      throw new Error('PUMPSWAP_DIP_WALLET_SECRET must not equal COPY_TRADER_WALLET_SECRET');
    }
    const pubkey = readPubkeyFromKeypairFile(dipSecret);
    if (pubkey === LIVE_OSCAR_MAIN_PUBKEY) {
      throw new Error('PUMPSWAP_DIP_WALLET_SECRET resolves to main live-oscar wallet');
    }
    if (pubkey === COPY_TRADER_RISKY_WALLET_PUBKEY) {
      throw new Error('PUMPSWAP_DIP_WALLET_SECRET resolves to copy-trader wallet — use a dedicated keypair');
    }
    if (cfg.walletPubkeyExpected && pubkey && pubkey !== cfg.walletPubkeyExpected) {
      throw new Error(
        `PUMPSWAP_DIP_WALLET_PUBKEY mismatch (expected ${cfg.walletPubkeyExpected.slice(0, 8)}…, got ${pubkey.slice(0, 8)}…)`,
      );
    }
  }
}
