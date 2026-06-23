/**
 * W8.0 Phase 3 — load trading keypair from LIVE_WALLET_SECRET (path or inline).
 * Call only when strategy enabled + executionMode simulate (P3-I1); never log secrets.
 */
import fs from 'node:fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

/** Strip BOM, comments-only lines, take first non-empty line, optional surrounding quotes. */
export function normalizeWalletSecretContent(raw: string): string {
  const noBom = raw.replace(/^\uFEFF/, '');
  const firstLine = noBom
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  if (!firstLine) return '';
  const unquoted =
    (firstLine.startsWith('"') && firstLine.endsWith('"')) ||
    (firstLine.startsWith("'") && firstLine.endsWith("'"))
      ? firstLine.slice(1, -1).trim()
      : firstLine;
  return unquoted.trim();
}

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

function looksLikeNumericByteList(content: string): boolean {
  if (!/^[\d,\s]+$/.test(content)) return false;
  return content.split(/[,\s]+/).filter(Boolean).length >= 64;
}

function keypairFromNumericByteList(content: string): Keypair {
  const parts = content.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 64) {
    throw new Error('numeric byte list must contain at least 64 values');
  }
  const u8 = Uint8Array.from(
    parts.map((p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) {
        throw new Error(`invalid byte value in keypair list: ${p}`);
      }
      return n;
    }),
  );
  return Keypair.fromSecretKey(u8);
}

/**
 * Resolve configured wallet path; `.keypair.txt` and `.keypair.json` are interchangeable on disk.
 */
export function resolveWalletSecretPath(configuredPath: string): string {
  try {
    if (fs.existsSync(configuredPath) && fs.statSync(configuredPath).isFile()) {
      return configuredPath;
    }
  } catch {
    return configuredPath;
  }

  let alt: string | null = null;
  if (configuredPath.endsWith('.keypair.json')) {
    alt = `${configuredPath.slice(0, -'.keypair.json'.length)}.keypair.txt`;
  } else if (configuredPath.endsWith('.keypair.txt')) {
    alt = `${configuredPath.slice(0, -'.keypair.txt'.length)}.keypair.json`;
  }

  if (alt) {
    try {
      if (fs.existsSync(alt) && fs.statSync(alt).isFile()) return alt;
    } catch {
      /* use configured path; read will fail with a clear message */
    }
  }

  return configuredPath;
}

/**
 * File on disk supports:
 * - Solana CLI JSON `[byte,...]`
 * - single-line Phantom/base58 secret (typical `.txt` export)
 * - comma- or space-separated byte list (64+ numbers)
 */
export function keypairFromWalletFileContent(fileRaw: string): Keypair {
  const content = normalizeWalletSecretContent(fileRaw);
  if (!content) throw new Error('keypair file is empty');

  if (content.startsWith('[')) {
    return keypairFromJsonFileContent(content);
  }
  if (looksLikeNumericByteList(content)) {
    return keypairFromNumericByteList(content);
  }

  try {
    return keypairFromBase58(content);
  } catch {
    try {
      return keypairFromJsonFileContent(content);
    } catch {
      throw new Error(
        'keypair file must be a JSON byte array, base58 secret key (one line), or comma/space-separated bytes',
      );
    }
  }
}

/**
 * Resolve secret: if `trimmed` points to an existing file, read it; else JSON array or base58.
 */
export function loadLiveKeypairFromSecretEnv(secretRaw: string): Keypair {
  const trimmed = secretRaw.trim();
  if (!trimmed) throw new Error('LIVE_WALLET_SECRET is empty');

  try {
    const filePath = resolveWalletSecretPath(trimmed);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const fileRaw = fs.readFileSync(filePath, 'utf8');
      return keypairFromWalletFileContent(fileRaw);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('keypair file')) throw e;
    throw new Error(`failed to read wallet keypair file: ${(e as Error).message}`);
  }

  const inline = normalizeWalletSecretContent(trimmed);
  if (inline.startsWith('[')) {
    return keypairFromJsonFileContent(inline);
  }
  if (looksLikeNumericByteList(inline)) {
    return keypairFromNumericByteList(inline);
  }

  try {
    return keypairFromBase58(inline);
  } catch {
    throw new Error(
      'LIVE_WALLET_SECRET is not a valid path, JSON keypair array, numeric byte list, or base58 secret',
    );
  }
}
