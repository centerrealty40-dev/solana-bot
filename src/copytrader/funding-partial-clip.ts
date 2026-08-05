/**
 * When free USDC cannot cover the full pending buy, take a fraction of the
 * planned size (default 50%) if the wallet can fund that clip, then leave the
 * remainder queued as a funding top-up for when cash returns and the premium
 * corridor still allows.
 */
import { roundUsd } from './entry-probe.js';

export type FundingPartialClipDecision =
  | { action: 'defer' }
  | { action: 'clip'; clipUsd: number; remainderUsd: number; originalUsd: number };

export function resolveFundingPartialClip(args: {
  enabled: boolean;
  requiredUsd: number;
  availableUsd: number;
  fraction: number;
  minUsd: number;
}): FundingPartialClipDecision {
  const { enabled, requiredUsd, availableUsd, fraction, minUsd } = args;
  if (!enabled) return { action: 'defer' };
  if (!(requiredUsd > 0) || !(availableUsd > 0)) return { action: 'defer' };
  if (availableUsd + 1e-6 >= requiredUsd) return { action: 'defer' };

  const frac = Math.min(1, Math.max(0, fraction));
  if (!(frac > 0 && frac < 1)) return { action: 'defer' };

  const clipUsd = roundUsd(requiredUsd * frac);
  if (!(clipUsd >= minUsd - 1e-9)) return { action: 'defer' };
  if (availableUsd + 1e-6 < clipUsd) return { action: 'defer' };

  const remainderUsd = roundUsd(Math.max(0, requiredUsd - clipUsd));
  return { action: 'clip', clipUsd, remainderUsd, originalUsd: roundUsd(requiredUsd) };
}

/** USD still needed to reach entryTarget after deployed cost basis. */
export function fundingTopUpRemainderUsd(args: {
  entryTargetUsd: number;
  deployedUsd: number;
  minUsd: number;
}): number {
  const { entryTargetUsd, deployedUsd, minUsd } = args;
  if (!(entryTargetUsd > 0)) return 0;
  const rem = roundUsd(entryTargetUsd - Math.max(0, deployedUsd));
  if (!(rem >= minUsd - 1e-9)) return 0;
  return rem;
}
