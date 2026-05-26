/**
 * Curated lists of well-known Solana addresses we want to EXCLUDE from
 * "alpha rotation network" candidate sets. These are funding sources that
 * appear in transfer graphs of basically every Solana wallet — keeping them
 * would drown the signal.
 *
 * Sources: publicly-tagged Solscan/Helius labels, ecosystem disclosures,
 * project documentation. Confidence is "high" for top-3 wallets per CEX,
 * "medium" for the rest. We add a runtime fan-in heuristic in
 * `rotation-graph.ts` to catch CEX hot wallets we haven't enumerated.
 *
 * IMPORTANT: do NOT add alpha trader addresses here. Anything in this set
 * is permanently invisible to the rotation discovery pipeline.
 */

export const CEX_HOT_WALLETS: ReadonlySet<string> = new Set([
  // Binance — primary deposit/withdrawal hot wallets
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  '3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQq9uzBWRVa',
  'F37Wb3pEwBvZ8DqVuNnzKNd7p7oJzPbcyUqDjTmjsmFB',

  // Coinbase
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',

  // Kraken
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',

  // OKX
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD',
  'EaWDnNoBvkKgN3MNKCWzkTumKW1Hw7UcwGv5Pf5aeCCA',

  // Bybit
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',

  // Gate.io
  '43DbAvKxhXh1oSxkJSqGosNw3HpBnmsWiak6tB5wpecN',

  // Crypto.com
  '6VV5uJvJtVhyt19LGKi65JaWg9CUuZ2sqbutD7r8rMVZ',

  // KuCoin
  'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6',

  // Bitget
  'A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR',
]);

/**
 * Solana program IDs / known DEX router accounts that show up in transfer
 * graphs as recipients of routing legs. NOT operator wallets.
 */
export const PROGRAM_ADDRESSES: ReadonlySet<string> = new Set([
  // Jupiter routers
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  // Raydium AMM v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  // Raydium CLMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  // Raydium CPMM + routing (program-addresses)
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
  // Pump.fun bonding curve
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  // Pump.fun PumpSwap AMM (post-migration)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  // Moonit / Moonshot launchpad (moonit-sdk IDL V4)
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
  // Meteora DLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  // Meteora DAMM v2
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  // Orca Whirlpool
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  // Phoenix
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  // Lifinity v2
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
  // SPL Token Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  // System Program (sometimes returned by aggregators in transfer fields)
  '11111111111111111111111111111111',
]);

/**
 * Combined exclusion set.
 */
export const EXCLUDED_ADDRESSES: ReadonlySet<string> = new Set([
  ...CEX_HOT_WALLETS,
  ...PROGRAM_ADDRESSES,
]);

export function isExcludedAddress(addr: string): boolean {
  return EXCLUDED_ADDRESSES.has(addr);
}

export function isCexHotWallet(addr: string): boolean {
  return CEX_HOT_WALLETS.has(addr);
}
