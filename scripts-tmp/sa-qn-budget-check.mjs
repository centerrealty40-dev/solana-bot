/**
 * W6.13 P0 — проверка согласованности ENV с целевым операционным потолком (~70%).
 *
 *   npm run sa-qn-budget-check
 *
 * Всегда exit 0; предупреждения только в stderr (cron-friendly).
 */
import 'dotenv/config';
import { auditOperationalBudgetDeclared, logOperationalBudgetWarnings } from './sa-qn-global-budget-lib.mjs';

const audit = logOperationalBudgetWarnings(process.env, { component: 'sa-qn-budget-check' });
console.log(
  JSON.stringify({
    ok: true,
    component: 'sa-qn-budget-check',
    audit: {
      globalCap: audit.globalCap,
      operationalCeiling: audit.operationalCeiling,
      sumOperationalDeclared: audit.sumOperationalDeclared,
      operationalOver: audit.operationalOver,
      botAnalyzer: audit.botAnalyzer,
      reserveOver: audit.reserveOver,
    },
  }),
);
