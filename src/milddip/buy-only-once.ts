import type { MildDipState } from './state.js';

export type MirrorBuyOnlyBoughtMintDecision = 'allow' | 'skip_already_bought';

export function mirrorBuyOnlyBoughtMintDecision(
  state: MildDipState,
  mint: string,
): MirrorBuyOnlyBoughtMintDecision {
  return state.mirrorBuyOnlyBoughtMints?.[mint] != null
    ? 'skip_already_bought'
    : 'allow';
}

export function recordMirrorBuyOnlyMint(
  state: MildDipState,
  mint: string,
  ts: number,
): boolean {
  if (state.mirrorBuyOnlyBoughtMints?.[mint] != null) return false;
  state.mirrorBuyOnlyBoughtMints ??= {};
  state.mirrorBuyOnlyBoughtMints[mint] = ts;
  return true;
}
