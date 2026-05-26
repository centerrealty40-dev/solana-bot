#!/usr/bin/env node
/**
 * Compare Jupiter quoted_out / in from swap ix tail vs wallet fill (confirmed txs).
 * Usage:
 *   node scripts-tmp/decode-jupiter-confirmed-slip.mjs <signature> [signature...]
 * Env:
 *   SA_RPC_HTTP_URL — required unless RPC_URL in argv env file
 *   LIVE_ENV_FILE — default /opt/solana-alpha/.env (reads SA_RPC_HTTP_URL)
 *   LIVE_WALLET_PUBKEY — default 2sSu7… (Oscar live wallet)
 */
import fs from 'node:fs';
import bs58 from 'bs58';

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

function rpcUrl() {
  const direct = process.env.SA_RPC_HTTP_URL?.trim();
  if (direct) return direct;
  const p = process.env.LIVE_ENV_FILE?.trim() || '/opt/solana-alpha/.env';
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const line = txt.split('\n').find((l) => l.startsWith('SA_RPC_HTTP_URL='));
    if (line) return line.slice('SA_RPC_HTTP_URL='.length).trim();
  } catch {
    /* ignore */
  }
  return '';
}

function uiStringToRaw(ui, decimals) {
  const neg = ui.startsWith('-');
  const s = neg ? ui.slice(1) : ui;
  const [intPart, fracPart = ''] = s.split('.');
  const ip = intPart.replace(/^0+/, '') || '0';
  const pad = decimals > 0 ? (fracPart + '0'.repeat(decimals)).slice(0, decimals) : '';
  const fracBig = decimals > 0 ? BigInt(pad.padEnd(decimals, '0')) : 0n;
  let v = BigInt(ip) * 10n ** BigInt(decimals) + fracBig;
  if (neg) v = -v;
  return v;
}

function rawFromRow(r) {
  const amt = r?.uiTokenAmount?.amount;
  if (typeof amt === 'string' && /^\d+$/.test(amt)) return BigInt(amt);
  const ui = r?.uiTokenAmount?.uiAmountString;
  const dec = r?.uiTokenAmount?.decimals;
  if (typeof ui === 'string' && typeof dec === 'number') return uiStringToRaw(ui, dec);
  return 0n;
}

function mintOwnerRawDelta(meta, mint, owner) {
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const byIdx = new Map();
  for (const r of pre) {
    if (r.mint !== mint || r.owner !== owner) continue;
    const cur = byIdx.get(r.accountIndex) ?? { pre: 0n, post: 0n };
    cur.pre = rawFromRow(r);
    byIdx.set(r.accountIndex, cur);
  }
  for (const r of post) {
    if (r.mint !== mint || r.owner !== owner) continue;
    const cur = byIdx.get(r.accountIndex) ?? { pre: 0n, post: 0n };
    cur.post = rawFromRow(r);
    byIdx.set(r.accountIndex, cur);
  }
  let sum = 0n;
  for (const v of byIdx.values()) sum += v.post - v.pre;
  return sum;
}

function signerIndex(keys, wallet) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const pk = typeof k === 'string' ? k : k?.pubkey;
    if (pk === wallet) return i;
  }
  return -1;
}

function solProceedsLamports(meta, walletPk, signerIdx) {
  const preB = meta.preBalances ?? [];
  const postB = meta.postBalances ?? [];
  const fee = BigInt(typeof meta.fee === 'number' && meta.fee >= 0 ? meta.fee : 0);
  let native = 0n;
  if (signerIdx >= 0 && signerIdx < preB.length && signerIdx < postB.length) {
    native = BigInt(postB[signerIdx] ?? 0) - BigInt(preB[signerIdx] ?? 0);
  }
  const wsolDelta = mintOwnerRawDelta(meta, WRAPPED_SOL, walletPk);
  return native + fee + wsolDelta;
}

/** Jupiter V6 Route + SharedAccountsRoute: last 19 bytes = in u64 LE + quoted_out u64 LE + slip u16 LE + pf u8 */
function readIxTail(raw) {
  if (raw.length < 8 + 19) return null;
  const inAmt = raw.readBigUInt64LE(raw.length - 19);
  const quotedOut = raw.readBigUInt64LE(raw.length - 11);
  const slipBps = raw.readUInt16LE(raw.length - 3);
  const pfBps = raw[raw.length - 1];
  return { inAmt, quotedOut, slipBps, pfBps };
}

async function fetchTx(u, sig) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
  };
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  return j.result;
}

function largestNonWsolTokenDelta(meta, wallet) {
  const mints = new Set();
  for (const r of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    if (r.mint && r.mint !== WRAPPED_SOL && r.owner === wallet) mints.add(r.mint);
  }
  let best = { mint: '', delta: 0n };
  let bestAbs = 0n;
  for (const m of mints) {
    const d = mintOwnerRawDelta(meta, m, wallet);
    if (d === 0n) continue;
    const abs = d < 0n ? -d : d;
    if (abs > bestAbs) {
      bestAbs = abs;
      best = { mint: m, delta: d };
    }
  }
  return best;
}

async function main() {
  const sigs = process.argv.slice(2).filter(Boolean);
  if (sigs.length === 0) {
    console.error('usage: node decode-jupiter-confirmed-slip.mjs <sig> [...]');
    process.exit(1);
  }
  const u = rpcUrl();
  if (!u) {
    console.error('missing SA_RPC_HTTP_URL / LIVE_ENV_FILE');
    process.exit(1);
  }
  const wallet =
    process.env.LIVE_WALLET_PUBKEY?.trim() || '2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc';

  const solUsd = Number(process.env.SPOT_SOL_USD || '') || (await fetchSolUsdSpot());

  const out = [];
  for (const sig of sigs) {
    const tx = await fetchTx(u, sig);
    if (!tx?.transaction?.message || !tx.meta) {
      out.push({ sig, error: 'tx_not_found_or_no_meta' });
      continue;
    }
    const msg = tx.transaction.message;
    const keys = msg.accountKeys ?? [];
    const ixs = msg.instructions ?? [];
    const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const ix = ixs.find((ix) => {
      const pid = typeof ix.programId === 'string' ? ix.programId : keys[ix.programIdIndex];
      return pid === JUP;
    });
    if (!ix?.data) {
      out.push({ sig, error: 'no_jupiter_ix' });
      continue;
    }
    const raw = Buffer.from(bs58.decode(ix.data));
    const disc = raw.slice(0, 8).toString('hex');
    const tail = readIxTail(raw);
    if (!tail) {
      out.push({ sig, disc, error: 'ix_too_short' });
      continue;
    }

    const ixIdx = signerIndex(keys, wallet);
    const solProceeds = solProceedsLamports(tx.meta, wallet, ixIdx);
    const { mint: tokMint, delta: tokDelta } = largestNonWsolTokenDelta(tx.meta, wallet);

    let sideGuess = null;
    let actualOut = 0n;
    let shortfall = 0n;
    let slipVsQuotePct = 0;
    let slipUsdApprox = 0;

    if (tokDelta > 0n) {
      sideGuess = 'buy_sol_for_token';
      actualOut = tokDelta;
      shortfall = tail.quotedOut > actualOut ? tail.quotedOut - actualOut : 0n;
      slipVsQuotePct = tail.quotedOut > 0n ? Number(shortfall) / Number(tail.quotedOut) * 100 : 0;
      slipUsdApprox =
        tail.quotedOut > 0n
          ? (Number(shortfall) / Number(tail.quotedOut)) * (Number(tail.inAmt) / 1e9) * solUsd
          : 0;
    } else if (tokDelta < 0n) {
      sideGuess = 'sell_token_for_sol';
      actualOut = solProceeds;
      shortfall = tail.quotedOut > actualOut ? tail.quotedOut - actualOut : 0n;
      slipVsQuotePct = tail.quotedOut > 0n ? Number(shortfall) / Number(tail.quotedOut) * 100 : 0;
      slipUsdApprox = (Number(shortfall) / 1e9) * solUsd;
    } else {
      sideGuess = 'unknown_token_delta';
    }

    out.push({
      sig,
      disc,
      primaryMint: tokMint.slice(0, 12),
      sideGuess,
      slipBpsEmbedded: tail.slipBps,
      inAtomic: String(tail.inAmt),
      quotedOutAtomic: String(tail.quotedOut),
      actualOutAtomic: String(actualOut),
      shortfallAtomic: String(shortfall),
      slipVsQuotePct,
      slipUsdApproxAtSpotSol: slipUsdApprox,
      spotSolUsdUsed: solUsd,
      note:
        'slipVsQuote = max(0, quoted_out−actual_fill) / quoted_out from Jupiter ix tail vs wallet deltas; USD uses Jupiter lite SOL spot at script run.',
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

async function fetchSolUsdSpot() {
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
    const j = await r.json();
    const px = Number(j?.[SOL_MINT]?.usdPrice ?? 0);
    if (px > 10 && px < 5000) return px;
  } catch {
    /* ignore */
  }
  return 100;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
