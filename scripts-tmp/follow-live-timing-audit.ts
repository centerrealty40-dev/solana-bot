/**
 * Live follow timing audit — entry lag vs leader, exit lead vs leader sell.
 * Usage: npx tsx scripts-tmp/follow-live-timing-audit.ts [journalPath] [sinceMinutes]
 */
import fs from 'node:fs';
import readline from 'node:readline';

const journal =
  process.argv[2]?.trim() ||
  process.env.PUMPSWAP_COMBO_FOLLOW_JOURNAL_PATH ||
  'data/pumpswap-combo-follow/journal.jsonl';
const sinceMin = Number(process.argv[3] ?? 60);
const sinceMs = Date.now() - sinceMin * 60_000;

type Ev = Record<string, unknown> & { kind?: string; ts?: number; mint?: string };

async function main(): Promise<void> {
  if (!fs.existsSync(journal)) {
    console.log(JSON.stringify({ error: 'journal_not_found', journal }));
    process.exit(1);
  }

  const events: Ev[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(journal), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Ev;
      if (Number(o.ts ?? 0) >= sinceMs) events.push(o);
    } catch {
      /* skip */
    }
  }

  const buyLags: number[] = [];
  const exitLeads: number[] = [];
  const errors: string[] = [];
  let buyOk = 0;
  let buyFail = 0;
  let sellOk = 0;
  let sellFail = 0;

  for (const e of events) {
    const k = String(e.kind ?? '');
    if (k === 'buy_fail' || k === 'add_fail') buyFail++;
    if (k === 'buy_ok' || k === 'mirror_buy_timing' || k === 'mirror_add_timing') {
      buyOk++;
      const lag = Number(e.lagMsAfterLeader);
      if (Number.isFinite(lag)) buyLags.push(lag);
    }
    if (k === 'sell_fail') sellFail++;
    if (k === 'partial_sell' || k === 'close' || k === 'round_trip') sellOk++;
    if (k === 'tick_error' || k === 'poll_rpc_fail') errors.push(k);
  }

  // Per-mint: first our exit vs next leader sell
  const byMint = new Map<string, Ev[]>();
  for (const e of events) {
    const m = String(e.mint ?? '');
    if (!m) continue;
    const arr = byMint.get(m) ?? [];
    arr.push(e);
    byMint.set(m, arr);
  }

  for (const [, evs] of byMint) {
    evs.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      const k = String(e.kind ?? '');
      if (k !== 'partial_sell' && k !== 'close' && k !== 'round_trip') continue;
      const ourTs = Number(e.ts ?? 0);
      const leaderSell = evs.slice(i + 1).find((x) => x.kind === 'leader_sell_observed');
      if (leaderSell) {
        exitLeads.push(Number(leaderSell.ts) - ourTs);
      }
    }
  }

  const pct = (arr: number[], p: number) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  };

  console.log(
    JSON.stringify(
      {
        journal,
        windowMin: sinceMin,
        events: events.length,
        buys: { ok: buyOk, fail: buyFail },
        sells: { partialOrClose: sellOk, fail: sellFail },
        entryLagMs: buyLags.length
          ? {
              n: buyLags.length,
              min: Math.min(...buyLags),
              p50: pct(buyLags, 50),
              p90: pct(buyLags, 90),
              max: Math.max(...buyLags),
              avg: Math.round(buyLags.reduce((a, b) => a + b, 0) / buyLags.length),
            }
          : null,
        exitLeadBeforeLeaderMs: exitLeads.length
          ? {
              n: exitLeads.length,
              min: Math.min(...exitLeads),
              p50: pct(exitLeads, 50),
              p90: pct(exitLeads, 90),
              max: Math.max(...exitLeads),
              pctBeforeLeader: +(
                (exitLeads.filter((x) => x > 0).length / exitLeads.length) *
                100
              ).toFixed(1),
            }
          : null,
        errors: [...new Set(errors)],
        kinds: Object.fromEntries(
          [...events.reduce((m, e) => m.set(String(e.kind), (m.get(String(e.kind)) ?? 0) + 1), new Map<string, number>())],
        ),
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
