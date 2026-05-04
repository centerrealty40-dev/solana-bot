/**
 * Mint gate helper (W6.9 §7). Pure function — tested without DB.
 */
export type MintDecision = 'NO_TRADE' | 'ALLOW_SCAN' | 'NEED_MORE_DATA';

export type MintDecisionOpts = {
  /** When true, empty early_buyers → NEED_MORE_DATA (strict W6.9). */
  requireSwapCoverage: boolean;
};

export function mintDecision(
  earlyBuyers: string[],
  decisionsByWallet: Map<string, string>,
  opts: MintDecisionOpts,
): MintDecision {
  if (opts.requireSwapCoverage && earlyBuyers.length === 0) {
    return 'NEED_MORE_DATA';
  }
  for (const w of earlyBuyers) {
    const d = decisionsByWallet.get(w);
    if (d === 'BLOCK_TRADE') {
      return 'NO_TRADE';
    }
  }
  return 'ALLOW_SCAN';
}
