import { describe, expect, it } from 'vitest';
import { auditOperationalBudgetDeclared } from '../scripts-tmp/sa-qn-global-budget-lib.mjs';

describe('auditOperationalBudgetDeclared (W6.13)', () => {
  it('does not flag when orchestrator cap alone is within 70%', () => {
    const a = auditOperationalBudgetDeclared({
      SA_QN_GLOBAL_CREDITS_PER_DAY: '1500000',
      SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY: '900000',
      SA_BACKFILL_ENABLED: '0',
      SCAM_FARM_ENABLE_RPC: '0',
    } as NodeJS.ProcessEnv);
    expect(a.operationalCeiling).toBe(1_050_000);
    expect(a.operationalOver).toBe(false);
  });

  it('flags when declared operational sum exceeds 70%', () => {
    const a = auditOperationalBudgetDeclared({
      SA_QN_GLOBAL_CREDITS_PER_DAY: '1500000',
      SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY: '1200000',
      SA_BACKFILL_MAX_CREDITS_PER_DAY: '200000',
      SCAM_FARM_ENABLE_RPC: '0',
    } as NodeJS.ProcessEnv);
    expect(a.sumOperationalDeclared).toBe(1_400_000);
    expect(a.operationalOver).toBe(true);
  });

  it('includes scam-farm RPC credits when enabled', () => {
    const a = auditOperationalBudgetDeclared({
      SA_QN_GLOBAL_CREDITS_PER_DAY: '1500000',
      SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY: '1000000',
      SA_BACKFILL_ENABLED: '0',
      SCAM_FARM_ENABLE_RPC: '1',
      SCAM_FARM_RPC_BUDGET: '100',
      QUICKNODE_CREDITS_PER_SOLANA_RPC: '30',
    } as NodeJS.ProcessEnv);
    expect(a.scamFarmRpc).toBe(3000);
    expect(a.sumOperationalDeclared).toBe(1_003_000);
    expect(a.operationalOver).toBe(false);
  });

  it('warns reserve when bot analyzer max exceeds ~30%', () => {
    const a = auditOperationalBudgetDeclared({
      SA_QN_GLOBAL_CREDITS_PER_DAY: '1500000',
      SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY: '500000',
      SA_BACKFILL_ENABLED: '0',
      SA_BOT_ANALYZER_MAX_CREDITS_PER_DAY: '500000',
      SCAM_FARM_ENABLE_RPC: '0',
    } as NodeJS.ProcessEnv);
    expect(a.reserveOver).toBe(true);
  });
});
