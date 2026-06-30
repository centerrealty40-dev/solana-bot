import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { CopyTraderConfig } from './config.js';
import { pubkeyFromWalletSecretPath } from './wallet-pubkey.js';

/** Main live-oscar wallet pubkey (shared-wallet mode uses the same keypair). */
export const LIVE_OSCAR_MAIN_PUBKEY = '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc';

/** Repurposed live-oscar-risky execution wallet (see COPY_TRADER_USE_RISKY_WALLET). */
export const COPY_TRADER_RISKY_WALLET_PUBKEY = 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19';

const FORBIDDEN_PATH_FRAGMENTS = [
  'pt1-oscar-live.jsonl',
  'live-oscar-mint-whitelist',
  'live-oscar-mint-blacklist',
  'live-oscar-mint-graduated',
  'organizer-paper',
  'paper-oscar',
  'priority-fee-cache-live-oscar',
];

function norm(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').toLowerCase();
}

function pathTouchesLiveOscar(p: string): boolean {
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
        const kp = Keypair.fromSecretKey(Uint8Array.from(j.map((n) => Number(n))));
        return kp.publicKey.toBase58();
      }
      const kp = Keypair.fromSecretKey(bs58.decode(raw));
      return kp.publicKey.toBase58();
    } catch {
      return null;
    }
  }
}

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

/**
 * Hard guard: copy-trader is a standalone process — no shared journals, keypairs, or live-oscar paths.
 */
export function assertCopyTraderIsolation(cfg: CopyTraderConfig): void {
  if (pathTouchesLiveOscar(cfg.journalPath)) {
    throw new Error(`COPY_TRADER_JOURNAL_PATH overlaps live-oscar/paper paths: ${cfg.journalPath}`);
  }
  if (pathTouchesLiveOscar(cfg.statePath)) {
    throw new Error(`COPY_TRADER_STATE_PATH overlaps live-oscar/paper paths: ${cfg.statePath}`);
  }

  const liveTrades = process.env.LIVE_TRADES_PATH?.trim();
  if (liveTrades && norm(cfg.journalPath) === norm(liveTrades)) {
    throw new Error('COPY_TRADER_JOURNAL_PATH must not equal LIVE_TRADES_PATH');
  }

  const liveSecret = process.env.LIVE_WALLET_SECRET?.trim();
  const copySecret = process.env.COPY_TRADER_WALLET_SECRET?.trim();
  const sharedOscarWallet = envBool(process.env.COPY_TRADER_SHARED_OSCAR_WALLET, false);
  if (
    liveSecret &&
    copySecret &&
    norm(liveSecret) === norm(copySecret) &&
    !sharedOscarWallet
  ) {
    throw new Error(
      'COPY_TRADER_WALLET_SECRET must not equal LIVE_WALLET_SECRET unless COPY_TRADER_SHARED_OSCAR_WALLET=1',
    );
  }

  if ((cfg.executionMode === 'live' || cfg.executionMode === 'dry_run') && copySecret) {
    const pubkey = readPubkeyFromKeypairFile(copySecret);
    if (pubkey === LIVE_OSCAR_MAIN_PUBKEY && !sharedOscarWallet) {
      throw new Error(
        'COPY_TRADER_WALLET_SECRET resolves to main live-oscar wallet — set COPY_TRADER_SHARED_OSCAR_WALLET=1',
      );
    }
    const allowRisky = envBool(process.env.COPY_TRADER_USE_RISKY_WALLET, false);
    if (pubkey === COPY_TRADER_RISKY_WALLET_PUBKEY && !allowRisky) {
      throw new Error(
        'COPY_TRADER_USE_RISKY_WALLET=1 required to sign from live-oscar-risky wallet (repurposed for copy-trader)',
      );
    }
    if (cfg.walletPubkeyExpected && pubkey && pubkey !== cfg.walletPubkeyExpected) {
      throw new Error(
        `COPY_TRADER_WALLET_PUBKEY mismatch (expected ${cfg.walletPubkeyExpected.slice(0, 8)}…, got ${pubkey.slice(0, 8)}…)`,
      );
    }
  }

  if (cfg.targetWallet && cfg.walletPubkeyExpected && cfg.targetWallet === cfg.walletPubkeyExpected) {
    throw new Error(
      'COPY_TRADER_TARGET_WALLET must differ from execution wallet — cannot copy-trade yourself',
    );
  }

  if (process.env.LIVE_STRATEGY_ENABLED === '1') {
    console.warn(
      '[copy-trader] LIVE_STRATEGY_ENABLED=1 in shell env — ignored; copy-trader uses only COPY_TRADER_* PM2 block',
    );
  }
}
