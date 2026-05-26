/**
 * Оффлайн-сверка закрытых live-сессий: сумма SOL-потоков по подтверждённым swap-tx из журнала
 * vs `netPnlUsd` в `live_position_close`. Использует тот же разбор meta, что live-slippage / tracker.
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *   npm run live-chain-pnl-audit -- [mint] [path/to.jsonl]
 *
 * Env: LIVE_RPC_HTTP_URL / SA_RPC_HTTP_URL, LIVE_TRADES_PATH, STRATEGY_ID, кошелёк — как у live-oscar.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { loadLiveOscarConfig } from '../src/live/config.js';
import { readLiveJournalLinesBounded } from '../src/live/replay-strategy-journal.js';
import { resolveLiveWalletPk } from '../src/live/slippage-from-journal.js';
import {
  fetchConfirmedTxMeta,
  messageAccountKeys,
  mintOwnerRawDelta,
  signerIndex,
  solProceedsLamports,
} from '../src/live/swap-tx-sol-proceeds.js';

function lineMatchesChannel(row: Record<string, unknown>): boolean {
  const ch = row.channel;
  return ch === undefined || ch === null || ch === 'live';
}

function readJournalLines(storePath: string, maxFileBytes: number): { lines: string[]; truncated: boolean } {
  if (!storePath?.trim() || !fs.existsSync(storePath)) return { lines: [], truncated: false };
  const st = fs.statSync(storePath);
  if (st.size <= maxFileBytes) {
    return {
      lines: fs.readFileSync(storePath, 'utf-8').split('\n').filter((l) => l.trim().length > 0),
      truncated: false,
    };
  }
  const { lines, truncated } = readLiveJournalLinesBounded(storePath, maxFileBytes);
  return { lines: lines.filter((l) => l.trim().length > 0), truncated };
}

interface MintSessionBuf {
  swaps: { sig: string; side: string; intentId: string }[];
}

interface CloseAuditRow {
  mint: string;
  exitTs: number;
  exitReason: string;
  journalNetPnlUsd: number;
  journalInvestedUsd: number;
  swapRowsSeen: number;
  uniqueSigs: number;
  chainSolNetLamports: string;
  chainSolNet: number;
  /** journalNetPnlUsd / spot — грубое сравнение с chainSolNet при одном spot на всю сессию. */
  journalNetPnlSolEquiv: number | null;
  /** journalNetPnlSolEquiv − chainSolNet (SOL); близко к 0 при согласованном USD↔SOL. */
  deltaSolJournalMinusChain: number | null;
  rpcMiss: number;
  tokenDeltaSumRaw: string;
}

function num(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const mintFilter = argv[0]?.trim() || '';
  const jsonlOverride = argv[1]?.trim() || '';

  const spotFlag = process.argv.find((a) => a.startsWith('--sol-usd='));
  const spotSolFromCli = spotFlag ? Number(spotFlag.split('=')[1]) : NaN;
  const jsonOnly = process.argv.includes('--json');

  const cfg = loadLiveOscarConfig();
  const storePath = jsonlOverride || cfg.liveTradesPath;
  const { lines, truncated } = readJournalLines(storePath, cfg.liveReplayMaxFileBytes);
  const walletPk = resolveLiveWalletPk(cfg);

  const spotSol =
    Number.isFinite(spotSolFromCli) && spotSolFromCli > 0
      ? spotSolFromCli
      : Number(process.env.AUDIT_SOL_USD_SPOT ?? '') || 0;

  const intentMeta = new Map<string, { mint: string; side: string }>();
  const bufByMint = new Map<string, MintSessionBuf>();
  const closes: CloseAuditRow[] = [];

  function ensureBuf(m: string): MintSessionBuf {
    let b = bufByMint.get(m);
    if (!b) {
      b = { swaps: [] };
      bufByMint.set(m, b);
    }
    return b;
  }

  for (const ln of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(row.strategyId ?? '') !== cfg.strategyId) continue;
    if (!lineMatchesChannel(row)) continue;

    const kind = String(row.kind ?? '');

    if (kind === 'execution_attempt') {
      const intentId = row.intentId != null ? String(row.intentId) : '';
      const mint = String(row.mint ?? '');
      const side = String(row.side ?? '');
      if (intentId && mint && (side === 'buy' || side === 'sell')) {
        intentMeta.set(intentId, { mint, side });
      }
      continue;
    }

    if (kind === 'execution_result') {
      const intentId = row.intentId != null ? String(row.intentId) : '';
      const status = String(row.status ?? '');
      const sigRaw = row.txSignature;
      const sig = typeof sigRaw === 'string' && sigRaw.length > 16 ? sigRaw : '';
      if (!intentId || status !== 'confirmed' || !sig) continue;
      const meta = intentMeta.get(intentId);
      if (!meta) continue;
      const buf = ensureBuf(meta.mint);
      buf.swaps.push({ sig, side: meta.side, intentId });
      continue;
    }

    if (kind === 'live_position_close') {
      const mint = String(row.mint ?? '');
      if (!mint || (mintFilter && mint !== mintFilter)) {
        bufByMint.delete(mint);
        continue;
      }
      const ct = row.closedTrade;
      if (!ct || typeof ct !== 'object') {
        bufByMint.delete(mint);
        continue;
      }
      const cto = ct as Record<string, unknown>;
      const buf = bufByMint.get(mint) ?? { swaps: [] };

      const ordered = buf.swaps;
      const seenSig = new Set<string>();
      const uniqueList: typeof ordered = [];
      for (const s of ordered) {
        if (seenSig.has(s.sig)) continue;
        seenSig.add(s.sig);
        uniqueList.push(s);
      }

      let chainSolNet = 0n;
      let rpcMiss = 0;
      let tokenDeltaSum = 0n;
      const txCache = new Map<string, Awaited<ReturnType<typeof fetchConfirmedTxMeta>>>();

      for (const sw of uniqueList) {
        let loaded = txCache.get(sw.sig);
        if (loaded === undefined) {
          loaded = await fetchConfirmedTxMeta(cfg, sw.sig);
          txCache.set(sw.sig, loaded);
        }
        if (!loaded) {
          rpcMiss += 1;
          continue;
        }
        const keys = messageAccountKeys(loaded.message as Record<string, unknown>);
        const ix = signerIndex(keys, walletPk);
        const flow = solProceedsLamports(loaded.meta, walletPk, ix);
        chainSolNet += flow;
        tokenDeltaSum += mintOwnerRawDelta(loaded.meta, mint, walletPk);
      }

      const journalNetPnlUsd = num(cto.netPnlUsd);
      const journalInvestedUsd = num(cto.totalInvestedUsd);
      const chainSolNetF = Number(chainSolNet) / 1e9;
      const journalNetPnlSolEquiv = spotSol > 0 ? journalNetPnlUsd / spotSol : null;
      const deltaSolJournalMinusChain =
        spotSol > 0 && journalNetPnlSolEquiv != null ? journalNetPnlSolEquiv - chainSolNetF : null;

      closes.push({
        mint,
        exitTs: num(cto.exitTs),
        exitReason: String(cto.exitReason ?? ''),
        journalNetPnlUsd,
        journalInvestedUsd,
        swapRowsSeen: ordered.length,
        uniqueSigs: uniqueList.length,
        chainSolNetLamports: chainSolNet.toString(),
        chainSolNet: chainSolNetF,
        journalNetPnlSolEquiv,
        deltaSolJournalMinusChain,
        rpcMiss,
        tokenDeltaSumRaw: tokenDeltaSum.toString(),
      });

      bufByMint.delete(mint);
    }
  }

  const out = {
    walletPk,
    storePath,
    journalTruncated: truncated,
    spotSolUsed: spotSol > 0 ? spotSol : null,
    note:
      spotSol <= 0
        ? 'Pass --sol-usd=N or AUDIT_SOL_USD_SPOT for USD columns (rough: chain SOL × spot − invested vs journal net).'
        : undefined,
    closes,
  };

  if (jsonOnly) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(
    JSON.stringify(
      {
        walletPk,
        storePath,
        journalTruncated: truncated,
        spotSolUsed: spotSol > 0 ? spotSol : null,
        note: out.note,
      },
      null,
      2,
    ),
  );
  for (const r of closes) {
    console.log(
      [
        r.mint.slice(0, 12) + '…',
        `exit=${r.exitReason}`,
        `journalNet=$${r.journalNetPnlUsd.toFixed(4)}`,
        `inv=$${r.journalInvestedUsd.toFixed(2)}`,
        `swaps=${r.uniqueSigs}/${r.swapRowsSeen}`,
        `chainSOL=${r.chainSolNet.toFixed(6)}`,
        spotSol > 0
          ? `jNetSolEquiv=${r.journalNetPnlSolEquiv?.toFixed(6)} Δsol(j−chain)=${r.deltaSolJournalMinusChain?.toFixed(6)}`
          : 'sol_equiv_skipped',
        `rpcMiss=${r.rpcMiss}`,
        `tokenΔ=${r.tokenDeltaSumRaw}`,
      ].join(' | '),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
