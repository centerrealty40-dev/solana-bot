import { afterEach, describe, expect, it } from 'vitest';
import {
  heliusRpcFallbackEnabled,
  heliusRpcPreferEnabled,
  heliusRpcUrlFromEnv,
  isHeliusRpcEndpoint,
  liveOscarRpcHttpUrlFromEnv,
  primarySolanaRpcUrlFromEnv,
  resolveSolanaRpcUrl,
} from '../src/core/rpc/resolve-solana-rpc-url.js';

describe('resolve-solana-rpc-url', () => {
  const snapshot: NodeJS.ProcessEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...snapshot };
  });

  it('primary prefers SA_RPC over legacy QuickNode env', () => {
    process.env.SA_RPC_HTTP_URL = 'https://solana-mainnet.g.alchemy.com/v2/test';
    process.env.QUICKNODE_HTTP_URL = 'https://qn.example/rpc';
    process.env.HELIUS_API_KEY = 'test-key';
    expect(primarySolanaRpcUrlFromEnv()).toBe('https://solana-mainnet.g.alchemy.com/v2/test');
    expect(resolveSolanaRpcUrl()).toBe('https://solana-mainnet.g.alchemy.com/v2/test');
  });

  it('builds Helius URL from API key', () => {
    delete process.env.HELIUS_RPC_URL;
    process.env.HELIUS_API_KEY = 'abc-123';
    expect(heliusRpcUrlFromEnv()).toBe('https://mainnet.helius-rpc.com/?api-key=abc-123');
  });

  it('useHeliusFallback returns Helius only', () => {
    process.env.SA_RPC_HTTP_URL = 'https://qn.example/rpc';
    process.env.HELIUS_API_KEY = 'k';
    expect(resolveSolanaRpcUrl({ useHeliusFallback: true })).toBe(
      'https://mainnet.helius-rpc.com/?api-key=k',
    );
  });

  it('helius fallback disabled unless explicitly enabled', () => {
    delete process.env.SOLANA_RPC_HELIUS_FALLBACK_ENABLED;
    expect(heliusRpcFallbackEnabled()).toBe(false);
    process.env.SOLANA_RPC_HELIUS_FALLBACK_ENABLED = '1';
    expect(heliusRpcFallbackEnabled()).toBe(true);
    process.env.SOLANA_RPC_HELIUS_FALLBACK_ENABLED = '0';
    expect(heliusRpcFallbackEnabled()).toBe(false);
  });

  it('liveOscarRpcHttpUrl uses Helius when prefer=1', () => {
    process.env.SA_RPC_HTTP_URL = 'https://qn.example/rpc';
    process.env.SOLANA_RPC_HELIUS_PREFER = '1';
    process.env.HELIUS_API_KEY = 'k';
    expect(liveOscarRpcHttpUrlFromEnv()).toBe('https://mainnet.helius-rpc.com/?api-key=k');
    expect(isHeliusRpcEndpoint(liveOscarRpcHttpUrlFromEnv()!)).toBe(true);
    expect(heliusRpcPreferEnabled()).toBe(true);
  });
});
