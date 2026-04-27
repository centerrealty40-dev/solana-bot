export function scoreForRules(
  rules: string[],
  opts: { anchorCount: number; funder: string | null; walletCount: number },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const rset = new Set(rules);

  if (rset.has('sync_fund')) {
    const bump = Math.min(45, 25 + Math.max(0, opts.walletCount - 2) * 4);
    score += bump;
    reasons.push(`sync_fund+${bump}`);
  }
  if (rset.has('orchestrate_split')) {
    const bump = 42;
    score += bump;
    reasons.push(`orchestrate_split+${bump}`);
  }
  if (rset.has('rug_cohort')) {
    const bump = Math.min(40, 20 + Math.max(0, opts.anchorCount) * 5);
    score += bump;
    reasons.push(`rug_cohort+${bump}`);
  }

  // Cross-rule bonus: orchestration + shared funding
  if (rset.has('orchestrate_split') && (rset.has('sync_fund') || (opts.funder && opts.walletCount >= 3))) {
    score += 20;
    reasons.push('cross_orchestrate_fund+20');
  }

  // Two+ rug anchor mints with same cohort
  if (opts.anchorCount >= 2) {
    score += 15;
    reasons.push('multi_anchor+15');
  }

  return { score: Math.min(100, score), reasons };
}

export function shouldAutoConfirm(
  score: number,
  rules: string[],
  strongScore: number,
): boolean {
  if (score >= strongScore) {
    return true;
  }
  // Explicit combo from spec: (1)+(3) approximated as sync + orchestration
  const s = new Set(rules);
  if (s.has('sync_fund') && s.has('orchestrate_split') && score >= strongScore * 0.88) {
    return true;
  }
  if (s.has('rug_cohort') && s.has('orchestrate_split') && score >= strongScore * 0.9) {
    return true;
  }
  return false;
}

