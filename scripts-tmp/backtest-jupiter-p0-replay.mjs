#!/usr/bin/env node
/**
 * Replay backtest for Jupiter P0 (entry-split corridor + near-miss dip).
 * Read-only on journal JSONL — no live Jupiter calls.
 *
 * Usage: node scripts-tmp/backtest-jupiter-p0-replay.mjs [path/to/pt1-oscar-live.jsonl] [days]
 */
import fs from 'node:fs';
import readline from 'node:readline';

const journalPath = process.argv[2] || 'data/live/pt1-oscar-live.jsonl';
const days = Number(process.argv[3] || 7);
const sinceMs = Date.now() - days * 86400_000;

const DIP_MIN = -16;
const NEAR_GAP = 4;
const SPLIT_MAX_UP = 3;

let entryOpenSingleLeg = 0;
let entryOpenWouldFixLeg2 = 0;
let nearMissEval = 0;
let nearMissWouldPassWith2PctLower = 0;

async function main() {
  if (!fs.existsSync(journalPath)) {
    console.error('missing journal:', journalPath);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: fs.createReadStream(journalPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if ((ev.ts ?? 0) < sinceMs) continue;

    if (ev.kind === 'live_position_open' && ev.openTrade?.liveStagedEntry?.entrySplitLeg2Done === false) {
      const legs = ev.openTrade.legs ?? [];
      if (legs.length === 1 && legs[0]?.reason === 'open') {
        entryOpenSingleLeg += 1;
        const anchor = ev.openTrade.liveStagedEntry.entrySplitAnchorUsd ?? ev.openTrade.avgEntryMarket;
        const snap = ev.openTrade.legs[0]?.marketPrice ?? anchor;
        if (anchor > 0 && snap > 0) {
          const snapCh = (snap / anchor - 1) * 100;
          if (snapCh > SPLIT_MAX_UP) {
            const jupEst = snap * 0.97;
            const jupCh = (jupEst / anchor - 1) * 100;
            if (jupCh <= SPLIT_MAX_UP && jupCh >= -10) entryOpenWouldFixLeg2 += 1;
          }
        }
      }
    }

    if (ev.kind === 'live_discovery_eval' && ev.pass === false) {
      const reasons = ev.reasons ?? [];
      const dipWindows = ev.dipPctByWindow ?? {};
      let best = null;
      for (const v of Object.values(dipWindows)) {
        const n = Number(v);
        if (Number.isFinite(n) && (best === null || n < best)) best = n;
      }
      if (best === null) continue;
      if (best <= DIP_MIN) continue;
      const gap = best - DIP_MIN;
      if (gap <= 0 || gap > NEAR_GAP) continue;
      nearMissEval += 1;
      const px = Number(ev.priceUsd ?? 0);
      if (!(px > 0)) continue;
      const lowered = px * 0.98;
      const adjDip = best + ((lowered / px - 1) * 100);
      if (adjDip <= DIP_MIN) nearMissWouldPassWith2PctLower += 1;
    }
  }

  console.log(JSON.stringify({
    journalPath,
    days,
    entrySplit: {
      opensWithOnlyLeg1: entryOpenSingleLeg,
      estimatedLeg2FixIfJupiterCorridor: entryOpenWouldFixLeg2,
    },
    nearMissDip: {
      evalsNearMissGap: nearMissEval,
      wouldPassIfJupiter2PctLower: nearMissWouldPassWith2PctLower,
      passRateIf2PctLower: nearMissEval > 0 ? +(nearMissWouldPassWith2PctLower / nearMissEval).toFixed(3) : null,
    },
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
