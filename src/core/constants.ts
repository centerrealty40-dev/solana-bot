/**
 * Well-known Solana token mints used as "quote" currency.
 */
export const QUOTE_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
} as const;

export type QuoteMint = (typeof QUOTE_MINTS)[keyof typeof QUOTE_MINTS];

export function isQuoteMint(mint: string): boolean {
  return Object.values(QUOTE_MINTS).includes(mint as QuoteMint);
}

/**
 * DEX program IDs we subscribe to via Helius webhooks.
 */
export const DEX_PROGRAMS = {
  raydiumAmmV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydiumClmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  raydiumCpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  raydiumRoute: 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
  jupiterV4: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  jupiterV6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpSwapAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  meteoraDlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  meteoraDammV2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  orcaWhirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  moonitLaunchpad: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
} as const;

/**
 * Default execution / risk knobs.
 */
export const DEFAULTS = {
  /** target hard slippage cap in any quote (bps) */
  hardSlippageBps: 100,
  /** simulated slippage applied to paper fills as fraction of `sizeUsd / liquidityUsd` */
  paperSlippageMultiplierBps: 50,
  /** Jupiter swap base fee bps (post-LP/route fees) — empirical floor */
  baseFeeBps: 10,
  /** minimum trade size in USD to be considered "real" (filters dust) */
  minTradeUsd: 50,
} as const;
