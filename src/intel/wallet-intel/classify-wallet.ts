import { pickPrimaryTagFromSet } from '../wallet-tagger.js';
import { BLOCK_TRADE_TAGS, BOT_PRIMARY_SUPPRESS_TAGS, SMART_TIER_A_TAGS } from './policy-tags.js';

export type WalletIntelDecisionCode = 'BLOCK_TRADE' | 'SMART_TIER_A' | 'UNKNOWN';

export type ClassifyOpts = {
  /** Wallet appears as participant on scam_farm_candidates over min score threshold */
  inScamFarmBlockSet: boolean;
  /** If true, mev_bot / bot_farm_* as primary suppresses SMART even when smart_money exists */
  botPrimarySuppressesSmart: boolean;
};

export type ClassifyResult = {
  decision: WalletIntelDecisionCode;
  score: number;
  reasons: string[];
  sources: Record<string, unknown>;
};

/**
 * Single-wallet classification from tag set + scam-farm membership.
 */
export function classifyWallet(tags: Set<string>, opts: ClassifyOpts): ClassifyResult {
  const reasons: string[] = [];
  const primary = pickPrimaryTagFromSet(tags);

  if (opts.inScamFarmBlockSet) {
    reasons.push('scam_farm_high_score_participant');
    return {
      decision: 'BLOCK_TRADE',
      score: 100,
      reasons,
      sources: { tags: [...tags], primaryTag: primary, scamFarm: true },
    };
  }

  for (const t of tags) {
    if (BLOCK_TRADE_TAGS.has(t)) {
      reasons.push(`block_tag:${t}`);
      return {
        decision: 'BLOCK_TRADE',
        score: 100,
        reasons,
        sources: { tags: [...tags], primaryTag: primary },
      };
    }
  }

  let smartEligible = false;
  for (const t of tags) {
    if (SMART_TIER_A_TAGS.has(t)) {
      smartEligible = true;
      break;
    }
  }

  if (smartEligible && opts.botPrimarySuppressesSmart && primary && BOT_PRIMARY_SUPPRESS_TAGS.has(primary)) {
    reasons.push(`smart_suppressed_by_primary:${primary}`);
    return {
      decision: 'UNKNOWN',
      score: 35,
      reasons,
      sources: { tags: [...tags], primaryTag: primary },
    };
  }

  if (smartEligible) {
    reasons.push('smart_tier_a_tag_present');
    return {
      decision: 'SMART_TIER_A',
      score: 72,
      reasons,
      sources: { tags: [...tags], primaryTag: primary },
    };
  }

  reasons.push('no_block_no_smart_signal');
  return {
    decision: 'UNKNOWN',
    score: 30,
    reasons,
    sources: { tags: [...tags], primaryTag: primary },
  };
}
