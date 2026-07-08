export interface HoldersDecisionMeta {
  holders_db: number;
  holders_live: number | null;
  holders_source: 'qn_addon' | 'qn_gpa' | 'cache_pos' | 'shyft' | 'db' | 'none';
  holders_age_ms: number | null;
  holders_fail_reason?: string;
  holders_used_for_gate: number;
  /** Set when cheapPass=true but holder count could not be resolved and buy was blocked. */
  holders_unknown_after_cheap_pass?: boolean;
}
