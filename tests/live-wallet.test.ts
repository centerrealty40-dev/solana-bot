import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadLiveKeypairFromSecretEnv } from '../src/live/wallet.js';

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

  it('loads inline JSON array', () => {
    const kp = Keypair.generate();
    const loaded = loadLiveKeypairFromSecretEnv(JSON.stringify(Array.from(kp.secretKey)));
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('loads base58 secret key bytes', () => {
    const kp = Keypair.generate();
    const loaded = loadLiveKeypairFromSecretEnv(bs58.encode(kp.secretKey));
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('throws on empty secret', () => {
    expect(() => loadLiveKeypairFromSecretEnv('  ')).toThrow(/empty/);
  });
});
