/**
 * Print a human-readable snapshot of the copy-trader (paper) state:
 *   - open positions (entry → unrealized vs. last seen swap price in DB)
 *   - last 24h closed positions with PnL
 *   - daily PnL row for hypothesis 'copy_h8'
 *
 *   npm run copy:status
 */
import { sql as dsql, desc, and, eq } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('copy-status');

const HYPOTHESIS_ID = 'copy_h8';

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function shortMint(m: string): string {
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

function shortWallet(w: string | undefined | null): string {
  if (!w) return '?';
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

function fmtAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60}m`;
  const days = Math.floor(h / 24);
  return `${days}d${h % 24}h`;
}

async function main(): Promise<void> {
  const seen = await db.execute<{ count: string }>(
    dsql`SELECT count(*)::text AS count FROM copy_seen_mints`,
  );
  const seenCount = Number((seen as unknown as Array<{ count: string }>)[0]?.count ?? 0);

  const open = await db
    .select()
    .from(schema.positions)
    .where(
      and(
        eq(schema.positions.hypothesisId, HYPOTHESIS_ID),
        eq(schema.positions.status, 'open'),
      ),
    )
    .orderBy(desc(schema.positions.openedAt));

  const closed = await db
    .select()
    .from(schema.positions)
    .where(
      and(
        eq(schema.positions.hypothesisId, HYPOTHESIS_ID),
        eq(schema.positions.status, 'closed'),
        dsql`${schema.positions.closedAt} > now() - interval '24 hours'`,
      ),
    )
    .orderBy(desc(schema.positions.closedAt))
    .limit(50);

  console.log(`copy-trader status (hypothesis=${HYPOTHESIS_ID})`);
  console.log('--------------------------------------------');
  console.log(`Mints ever claimed (first-N): ${seenCount}`);
  console.log(`Open paper positions:        ${open.length}`);
  console.log(`Closed in last 24h:          ${closed.length}`);
  if (closed.length > 0) {
    const totalPnl = closed.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
    const wins = closed.filter((p) => (p.realizedPnlUsd ?? 0) > 0).length;
    const wr = (wins / closed.length) * 100;
    console.log(
      `24h realized PnL:            ${fmtUsd(totalPnl)} | wr ${wr.toFixed(0)}% | ${wins}/${closed.length} wins`,
    );
  }
  console.log('');

  if (open.length > 0) {
    console.log('Open positions:');
    console.log('Pos  Mint           Leader        Entry        Size      Age');
    console.log('---  -------------  ------------  -----------  --------  --------');
    for (const p of open.slice(0, 30)) {
      const meta = (p.signalMeta ?? {}) as Record<string, unknown>;
      const leader = String(meta.triggerWallet ?? '?');
      console.log(
        `${String(p.id).padEnd(3)}  ${shortMint(p.baseMint).padEnd(13)}  ${shortWallet(leader).padEnd(12)}  ${('$' + p.entryPriceUsd.toFixed(6)).padEnd(11)}  ${fmtUsd(p.sizeUsd).padEnd(8)}  ${fmtAge(p.openedAt)}`,
      );
    }
    if (open.length > 30) console.log(`... and ${open.length - 30} more`);
    console.log('');
  }

  if (closed.length > 0) {
    console.log('Closed positions (last 24h):');
    console.log('Pos  Mint           Leader        PnL        Pct      Held       Reason');
    console.log('---  -------------  ------------  ---------  -------  ---------  -----------');
    for (const p of closed.slice(0, 30)) {
      const meta = (p.signalMeta ?? {}) as Record<string, unknown>;
      const leader = String(meta.triggerWallet ?? '?');
      const pct =
        p.exitPriceUsd && p.entryPriceUsd
          ? ((p.exitPriceUsd / p.entryPriceUsd - 1) * 100).toFixed(1) + '%'
          : '-';
      const heldMs = (p.closedAt?.getTime() ?? Date.now()) - p.openedAt.getTime();
      const heldMin = Math.floor(heldMs / 60000);
      const held =
        heldMin < 60
          ? `${heldMin}m`
          : heldMin < 1440
            ? `${Math.floor(heldMin / 60)}h${heldMin % 60}m`
            : `${Math.floor(heldMin / 1440)}d`;
      console.log(
        `${String(p.id).padEnd(3)}  ${shortMint(p.baseMint).padEnd(13)}  ${shortWallet(leader).padEnd(12)}  ${fmtUsd(p.realizedPnlUsd ?? 0).padEnd(9)}  ${pct.padEnd(7)}  ${held.padEnd(9)}  ${(p.closeReason ?? '').slice(0, 20)}`,
      );
    }
    if (closed.length > 30) console.log(`... and ${closed.length - 30} more`);
  }

  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'copy-status failed');
  process.exit(1);
});
