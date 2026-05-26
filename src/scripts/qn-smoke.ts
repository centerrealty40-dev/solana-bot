import 'dotenv/config';
import { qnCall, qnUsageSnapshot } from '../core/rpc/qn-client.js';

async function main(): Promise<void> {
  const cost = 30;
  const r = await qnCall<number>('getSlot', [], { feature: 'safety', creditsPerCall: cost });
  const snap = qnUsageSnapshot();
  const creditsSpent = r.ok ? cost : 0;
  console.log(
    JSON.stringify(
      {
        ok: r.ok,
        reason: r.ok ? undefined : r.reason,
        message: r.ok ? undefined : r.message,
        creditsSpent,
        snapshot: snap,
      },
      null,
      2,
    ),
  );
  if (!r.ok) process.exitCode = 1;
}

void main();
