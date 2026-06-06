import fs from 'node:fs';

import { loadHyperliquidMarketCache } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import { markPxForCoin } from '../src/hyperliquid/twap/paper-trader.js';

const path = process.argv[2] ?? 'data/hl-twap/live.jsonl';
const rows = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const opens = new Map();
const closed = [];

for (const r of rows) {
  if (r.kind === 'open') opens.set(r.hash, r);
  if (r.kind === 'close') {
    const o = opens.get(r.hash);
    if (o) closed.push({ ...o, ...r });
    opens.delete(r.hash);
  }
}

const cache = await loadHyperliquidMarketCache();

console.log('=== CLOSED TRADES ===');
for (const t of closed) {
  const dir = t.side === 'buy' ? 'LONG' : 'SHORT';
  const whale = t.side === 'buy' ? 'whale BUY TWAP' : 'whale SELL TWAP';
  const pxMove = ((t.exitPx - t.entryAnchorPx) / t.entryAnchorPx) * 100;
  const favorable = t.side === 'buy' ? pxMove : -pxMove;
  console.log(
    `${t.displaySymbol} ${dir} (${whale}) entry=${t.entryAnchorPx} exit=${t.exitPx} priceMove=${pxMove.toFixed(2)}% favorable=${favorable.toFixed(2)}% pnl=${t.pnlPct.toFixed(2)}% reason=${t.exitReason}`,
  );
}

console.log('\n=== OPEN NOW ===');
for (const t of opens.values()) {
  const mark = markPxForCoin(t.coin, cache) || cache.mids.get(t.displaySymbol) || 0;
  const dir = t.side === 'buy' ? 'LONG' : 'SHORT';
  const whale = t.side === 'buy' ? 'whale BUY TWAP' : 'whale SELL TWAP';
  const pxMove = mark > 0 ? ((mark - t.entryAnchorPx) / t.entryAnchorPx) * 100 : 0;
  const favorable = t.side === 'buy' ? pxMove : -pxMove;
  console.log(
    `${t.displaySymbol} ${dir} (${whale}) entry=${t.entryAnchorPx} mark=${mark} priceMove=${pxMove.toFixed(2)}% favorable=${favorable.toFixed(2)}% dca=${t.dcaLevelsTaken} tp=${t.tpLevelsTaken}`,
  );
}
