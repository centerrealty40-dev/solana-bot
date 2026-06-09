/**
 * Exit mix stats for pumpswap-combo-follow paper journal.
 * Usage: npx tsx scripts-tmp/follow-paper-journal-stats.ts [journalPath]
 */
import fs from 'node:fs';
import readline from 'node:readline';

const journal =
  process.argv[2]?.trim() ||
  process.env.PUMPSWAP_COMBO_FOLLOW_JOURNAL_PATH ||
  'data/pumpswap-combo-follow/paper-journal.jsonl';

type Ev = Record<string, unknown>;

async function main(): Promise<void> {
  if (!fs.existsSync(journal)) {
    console.log(JSON.stringify({ error: 'journal_not_found', journal }));
    process.exit(1);
  }

  const counts: Record<string, number> = {};
  const exits: Record<string, number> = {};
  const roundTrips: Array<{ exitReason: string; pnlUsd: number; pnlPct: number }> = [];
  let lastHeartbeat: Ev | null = null;

  const rl = readline.createInterface({ input: fs.createReadStream(journal), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: Ev;
    try {
      o = JSON.parse(line) as Ev;
    } catch {
      continue;
    }
    const kind = String(o.kind ?? '');
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === 'heartbeat') lastHeartbeat = o;
    if (kind === 'round_trip') {
      const exitReason = String(o.exitReason ?? 'unknown');
      exits[exitReason] = (exits[exitReason] ?? 0) + 1;
      roundTrips.push({
        exitReason,
        pnlUsd: Number(o.pnlUsd ?? 0),
        pnlPct: Number(o.pnlPct ?? 0),
      });
    }
    if (kind === 'partial_sell') {
      const er = String(o.exitReason ?? 'partial');
      exits[er] = (exits[er] ?? 0) + 1;
    }
  }

  const wins = roundTrips.filter((r) => r.pnlUsd > 0).length;
  const ladderExits = (exits.tp1 ?? 0) + (exits.tp2 ?? 0);
  const slExits = exits.stop_loss ?? 0;

  console.log(
    JSON.stringify(
      {
        journal,
        eventCounts: counts,
        roundTrips: roundTrips.length,
        exitReasonCounts: exits,
        exitViaLadderPct: roundTrips.length
          ? +(((roundTrips.filter((r) => r.exitReason === 'tp1' || r.exitReason === 'tp2').length) /
              roundTrips.length) *
            100).toFixed(1)
          : 0,
        partialTp1: exits.tp1 ?? 0,
        fullTp2: exits.tp2 ?? 0,
        stopLoss: slExits,
        winRatePct: roundTrips.length ? +((wins / roundTrips.length) * 100).toFixed(1) : 0,
        sumPnlUsd: +roundTrips.reduce((s, r) => s + r.pnlUsd, 0).toFixed(2),
        lastHeartbeat,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ error: (e as Error).message }));
  process.exit(1);
});
