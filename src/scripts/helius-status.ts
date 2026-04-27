import { getUsageSnapshot } from '../core/helius-guard.js';

/**
 * Print a quick credit-usage snapshot for the current API key.
 *
 * Usage:
 *   npm run helius:status
 */
async function main(): Promise<void> {
  const s = await getUsageSnapshot();
  console.log('Helius credit usage');
  console.log('-------------------');
  console.log(`mode:           ${s.mode}`);
  console.log(`today:          ${s.today.toLocaleString()} / ${s.dailyBudget.toLocaleString()} (${s.dailyPctUsed}%)`);
  console.log(`this month:     ${s.thisMonth.toLocaleString()} / ${s.monthlyBudget.toLocaleString()} (${s.monthlyPctUsed}%)`);
  console.log('');
  if (s.dailyPctUsed > 80) console.warn('WARNING: daily budget >80% used');
  if (s.monthlyPctUsed > 80) console.warn('WARNING: monthly budget >80% used');
  process.exit(0);
}

main().catch((err) => {
  console.error('helius-status failed:', err);
  process.exit(1);
});
