/**
 * Tag sets for wallet_intel policy (W6.11). Keep in sync with wallet-tagger vocabulary.
 */
export const BLOCK_TRADE_TAGS = new Set([
  'scam_operator',
  'scam_proxy',
  'scam_treasury',
  'scam_payout',
  'farm_linked',
]);

/** Primary tag blocks smart promotion when WALLET_INTEL_BOT_PRIMARY_SUPPRESSES_SMART=1 */
export const BOT_PRIMARY_SUPPRESS_TAGS = new Set(['mev_bot', 'bot_farm_boss', 'bot_farm_distributor']);

export const SMART_TIER_A_TAGS = new Set(['smart_money', 'insider', 'rotation_node', 'lp_provider']);
