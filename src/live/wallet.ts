/**
 * W8.0 Phase 3 — load trading keypair from LIVE_WALLET_SECRET (path or inline).
 * Call only when strategy enabled + executionMode simulate (P3-I1); never log secrets.
 */
import fs from 'node:fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

function keypairFromJsonFileContent(raw: string): Keypair {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error('keypair file must be JSON array of at least 64 bytes');
  }
  const u8 = Uint8Array.from(parsed.map((n) => Number(n)));
  return Keypair.fromSecretKey(u8);
}

function keypairFromBase58(trimmed: string): Keypair {
  const decoded = bs58.decode(trimmed);
  return Keypair.fromSecretKey(decoded);
}

/**
 * File on disk: Solana CLI JSON `[byte,...]` **or** a single-line Phantom/base58 secret (common export).
 */
function keypairFromWalletFileContent(fileRaw: string): Keypair {
  const content = fileRaw.trim();
  if (!content) throw new Error('keypair file is empty');
  if (content.startsWith('[')) {
    return keypairFromJsonFileContent(content);
  }
  try {
    return keypairFromBase58(content);
  } catch {
    return keypairFromJsonFileContent(content);
  }
}

/**
 * Resolve secret: if `trimmed` points to an existing file, read it; else JSON array or base58.
 */
export function loadLiveKeypairFromSecretEnv(secretRaw: string): Keypair {
  const trimmed = secretRaw.trim();
  if (!trimmed) throw new Error('LIVE_WALLET_SECRET is empty');

  try {
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
      const fileRaw = fs.readFileSync(trimmed, 'utf8');
      return keypairFromWalletFileContent(fileRaw);
    }
  } catch (e) {
    throw new Error(`failed to read wallet keypair file: ${(e as Error).message}`);
  }

  if (trimmed.startsWith('[')) {
    return keypairFromJsonFileContent(trimmed);
  }

  try {
    return keypairFromBase58(trimmed);
  } catch {
    throw new Error('LIVE_WALLET_SECRET is not a valid path, JSON keypair array, or base58 secret');
  }
}
