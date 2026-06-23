import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  keypairFromWalletFileContent,
  loadLiveKeypairFromSecretEnv,
  normalizeWalletSecretContent,
  resolveWalletSecretPath,
} from '../src/live/wallet.js';

describe('loadLiveKeypairFromSecretEnv', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-wallet-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads JSON array from file path', () => {
    const kp = Keypair.generate();
    const fp = path.join(tmpDir, 'kp.json');
    fs.writeFileSync(fp, JSON.stringify(Array.from(kp.secretKey)), 'utf8');

    const loaded = loadLiveKeypairFromSecretEnv(fp);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('loads base58 secret from .txt file path', () => {
    const kp = Keypair.generate();
    const fp = path.join(tmpDir, 'wallet.keypair.txt');
    fs.writeFileSync(fp, `${bs58.encode(kp.secretKey)}\n`, 'utf8');

    const loaded = loadLiveKeypairFromSecretEnv(fp);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('falls back from configured .txt path to existing .json sibling', () => {
    const kp = Keypair.generate();
    const jsonPath = path.join(tmpDir, 'live-oscar-preset-c.keypair.json');
    const txtPath = path.join(tmpDir, 'live-oscar-preset-c.keypair.txt');
    fs.writeFileSync(jsonPath, JSON.stringify(Array.from(kp.secretKey)), 'utf8');

    expect(resolveWalletSecretPath(txtPath)).toBe(jsonPath);
    const loaded = loadLiveKeypairFromSecretEnv(txtPath);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('falls back from configured .json path to existing .txt sibling', () => {
    const kp = Keypair.generate();
    const jsonPath = path.join(tmpDir, 'live-oscar-preset-c.keypair.json');
    const txtPath = path.join(tmpDir, 'live-oscar-preset-c.keypair.txt');
    fs.writeFileSync(txtPath, bs58.encode(kp.secretKey), 'utf8');

    expect(resolveWalletSecretPath(jsonPath)).toBe(txtPath);
    const loaded = loadLiveKeypairFromSecretEnv(jsonPath);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('loads inline JSON array', () => {
    const kp = Keypair.generate();
    const loaded = loadLiveKeypairFromSecretEnv(JSON.stringify(Array.from(kp.secretKey)));
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('loads base58 secret key bytes inline', () => {
    const kp = Keypair.generate();
    const loaded = loadLiveKeypairFromSecretEnv(bs58.encode(kp.secretKey));
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('loads comma-separated byte list from file', () => {
    const kp = Keypair.generate();
    const bytes = Array.from(kp.secretKey).join(', ');
    const loaded = keypairFromWalletFileContent(bytes);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('strips BOM and uses first non-empty line', () => {
    const kp = Keypair.generate();
    const raw = `\uFEFF# wallet export\n${bs58.encode(kp.secretKey)}\n`;
    expect(normalizeWalletSecretContent(raw)).toBe(bs58.encode(kp.secretKey));
    const loaded = keypairFromWalletFileContent(raw);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('throws on empty secret', () => {
    expect(() => loadLiveKeypairFromSecretEnv('  ')).toThrow(/empty/);
  });
});
