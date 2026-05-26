/**
 * On-demand QuickNode Admin API usage for arbitrary UTC windows (same credits model as sa-stream).
 *
 * Usage:
 *   npx tsx src/scripts/quicknode-usage-window.ts --minutes 30
 *   npx tsx src/scripts/quicknode-usage-window.ts 10 30 90
 *
 * Requires QUICKNODE_ADMIN_API_KEY or QUICKNODE_ADMIN_API_KEY_FILE (Console REST).
 */
import 'dotenv/config';
import {
  fetchQuickNodeBillingPeriodSummary,
  fetchQuickNodeRpcUsageWindow,
} from '../core/rpc/quicknode-provider-usage.js';

function parseMinuteArgs(): number[] {
  const args = process.argv.slice(2);
  const out: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--minutes' || a === '-m') {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) out.push(n);
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(a)) {
      const n = Number(a);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  if (out.length === 0) out.push(30);
  return [...new Set(out)]
    .map((x) => Math.floor(x))
    .filter((n) => n > 0 && n <= 24 * 60)
    .sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const minutesList = parseMinuteArgs();
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowSec * 1000).toISOString();

  const billing = await fetchQuickNodeBillingPeriodSummary();
  if (billing) {
    const s = billing.start_time != null ? new Date(billing.start_time * 1000).toISOString() : '?';
    const e = billing.end_time != null ? new Date(billing.end_time * 1000).toISOString() : '?';
    console.log(`Billing period (API): ${s} → ${e}`);
    console.log(
      `  credits_used (period): ${billing.credits_used.toLocaleString('en-US')} / limit ${billing.limit.toLocaleString('en-US')} — remaining ${billing.credits_remaining.toLocaleString('en-US')}`,
    );
  } else {
    console.log('Billing period: (API unavailable — check QUICKNODE_ADMIN_API_KEY*)');
  }

  console.log('');
  console.log(`Now (UTC): ${nowIso}`);
  for (const minutes of minutesList) {
    const startSec = nowSec - minutes * 60;
    const startIso = new Date(startSec * 1000).toISOString();
    const w = await fetchQuickNodeRpcUsageWindow(startSec, nowSec);
    const used = w?.credits_used;
    console.log(
      `Last ${minutes} min: ${used != null && Number.isFinite(used) ? Math.round(used).toLocaleString('en-US') : 'n/a'} credits  (${startIso} .. ${nowIso})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
