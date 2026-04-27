import { createHash } from 'node:crypto';

const RULES = [
  'sync_fund',
  'rug_cohort',
  'orchestrate_split',
] as const;

export type ScamRuleId = (typeof RULES)[number] | (string & {});

/**
 * Deterministic 64-hex id from funder + participant set + anchor mints (rules
 * are merged into the row, not part of the key, so new evidence appends in-place).
 */
export function makeCandidateId(parts: {
  funder: string | null;
  wallets: string[];
  anchorMints: string[];
}): string {
  const w = [...new Set(parts.wallets.map((a) => a.trim()).filter(Boolean))].sort();
  const m = [...new Set(parts.anchorMints.map((a) => a.trim()).filter(Boolean))].sort();
  const raw = [parts.funder?.trim() ?? '', w.join(','), m.join(',')].join('|');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export { RULES };
