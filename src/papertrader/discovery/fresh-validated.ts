import type { PaperTraderConfig } from '../config.js';

export async function fetchFreshValidatedCandidates(_cfg: PaperTraderConfig): Promise<never[]> {
  // Implemented in W6.7 (FV-lane — uses tokens.metadata + holders enrichment).
  return [];
}
