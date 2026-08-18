/**
 * One-off: quote or force-close selected mild-dip wallet positions.
 *
 * Usage:
 *   npx tsx scripts-tmp/milddip-force-exit.ts --lane main --orphans
 *   npx tsx scripts-tmp/milddip-force-exit.ts --lane mirror --orphans --execute
 *   npx tsx scripts-tmp/milddip-force-exit.ts --lane main --managed <mint> --include-managed --execute
 *   npx tsx scripts-tmp/milddip-force-exit.ts --lane main --mint <mint> --mint <mint>
 *
 * Dry-run is the default. Real sales require --execute. The selected lane's
 * ecosystem env is loaded into the standard MILD_DIP_* variables; no wallet
 * or data path is hardcoded here. The script never edits state.json. After a
 * managed position's tokens disappear, the running bot reconciles it through
 * verdictDropEmptyOnNoBalance → confirmed_empty (120s grace).
 */
import 'dotenv/config';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { copyQuoteSpec, copySellQuotePriceUsd } from '../src/copytrader/quote-mint.js';
import { loadMildDipConfig } from '../src/milddip/config.js';
import { mildDipToCopyTraderConfig } from '../src/milddip/exec-bridge.js';
import { HOLDING_DUST_RAW } from '../src/milddip/sell-empty-guard.js';
import { loadMildDipState } from '../src/milddip/state.js';

type Lane = 'main' | 'mirror';
type EcosystemApp = { name?: string; env?: Record<string, unknown> };
type EcosystemConfig = { apps?: EcosystemApp[] };

type Options = {
  lane: Lane;
  mode: 'orphans' | 'mints';
  mints: string[];
  includeManaged: boolean;
  execute: boolean;
  maxSales: number;
  delayMs: number;
  minValueUsd: number;
};

type QuoteResult = {
  estimatedUsd: number;
  mark: number;
};

type Runtime = {
  executeCopySell: typeof import('../src/copytrader/executor.js')['executeCopySell'];
  fetchMintBalanceRaw: typeof import('../src/copytrader/live-exec.js')['fetchMintBalanceRaw'];
  copyTraderLiveOscarBridge: typeof import('../src/copytrader/live-bridge.js')['copyTraderLiveOscarBridge'];
  liveSellQuoteAndPrepareSnapshot: typeof import('../src/live/jupiter.js')['liveSellQuoteAndPrepareSnapshot'];
  resolveLiveJupiterQuoteUrl: typeof import('../src/live/jupiter.js')['resolveLiveJupiterQuoteUrl'];
  jupiterJsonHeaders: typeof import('../src/core/jupiter-http.js')['jupiterJsonHeaders'];
  listOrphanTokenAccounts: typeof import('../src/milddip/orphan-janitor.js')['listOrphanTokenAccounts'];
};

const PROTECTED_MINTS = new Set([
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
]);

const DEFAULT_MAX_SALES = 10;
const DEFAULT_DELAY_MS = 1_000;
const DEFAULT_MIN_VALUE_USD = 0.5;

function usage(): string {
  return [
    'usage:',
    '  npx tsx scripts-tmp/milddip-force-exit.ts --lane main|mirror --orphans [options]',
    '  npx tsx scripts-tmp/milddip-force-exit.ts --lane main|mirror --mint <mint> [--mint <mint> ...] [options]',
    '  npx tsx scripts-tmp/milddip-force-exit.ts --lane main|mirror --managed <mint> --include-managed [options]',
    '',
    'options:',
    '  --execute                 execute sales (default: --dry-run)',
    '  --dry-run                 quote only; does not send transactions',
    `  --max-sales <n>            max quote/sell candidates (default: ${DEFAULT_MAX_SALES})`,
    `  --delay-ms <n>              pause between candidates (default: ${DEFAULT_DELAY_MS})`,
    `  --min-value-usd <n>         skip quotes below this value (default: ${DEFAULT_MIN_VALUE_USD})`,
    '  --include-managed           allow mints present in the selected state.open',
  ].join('\n');
}

function parseNonNegative(raw: string, flag: string, integer = false): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${flag} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  let lane: Lane | undefined;
  let mode: Options['mode'] | undefined;
  const mints: string[] = [];
  let includeManaged = false;
  let managedMintRequested = false;
  let execute = false;
  let maxSales = DEFAULT_MAX_SALES;
  let delayMs = DEFAULT_DELAY_MS;
  let minValueUsd = DEFAULT_MIN_VALUE_USD;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lane') {
      const value = argv[++i]?.trim();
      if (value !== 'main' && value !== 'mirror') {
        throw new Error('--lane must be main or mirror');
      }
      lane = value;
    } else if (arg === '--orphans') {
      if (mode) throw new Error('choose exactly one of --orphans or --mint/--managed');
      mode = 'orphans';
    } else if (arg === '--mint' || arg === '--managed') {
      if (mode === 'orphans') throw new Error('choose exactly one of --orphans or --mint/--managed');
      const mint = argv[++i]?.trim();
      if (!mint) throw new Error(`${arg} requires a mint`);
      mode = 'mints';
      mints.push(mint);
      if (arg === '--managed') managedMintRequested = true;
    } else if (arg === '--include-managed') {
      includeManaged = true;
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--dry-run') {
      execute = false;
    } else if (arg === '--max-sales') {
      maxSales = parseNonNegative(argv[++i] ?? '', '--max-sales', true);
      if (maxSales < 1) throw new Error('--max-sales must be at least 1');
    } else if (arg === '--delay-ms') {
      delayMs = parseNonNegative(argv[++i] ?? '', '--delay-ms', true);
    } else if (arg === '--min-value-usd') {
      minValueUsd = parseNonNegative(argv[++i] ?? '', '--min-value-usd');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!lane) throw new Error('--lane is required');
  if (!mode || (mode === 'mints' && mints.length === 0)) {
    throw new Error('choose --orphans or at least one --mint/--managed');
  }
  if (mode === 'orphans' && mints.length > 0) {
    throw new Error('cannot combine --orphans with explicit mints');
  }
  if (managedMintRequested && !includeManaged) {
    throw new Error('--managed requires explicit --include-managed');
  }

  return { lane, mode, mints, includeManaged, execute, maxSales, delayMs, minValueUsd };
}

function loadLaneEnvironment(lane: Lane): void {
  const require = createRequire(import.meta.url);
  const ecosystem = require('../ecosystem.config.cjs') as EcosystemConfig;
  const appName = lane === 'mirror' ? 'mild-dip-mirror' : 'mild-dip-bot';
  const app = ecosystem.apps?.find((candidate) => candidate.name === appName);
  if (!app?.env) throw new Error(`ecosystem app env unavailable: ${appName}`);
  for (const [key, value] of Object.entries(app.env)) {
    if (typeof value === 'string') process.env[key] = value;
  }
}

function loadConfigOrThrow() {
  try {
    return loadMildDipConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`live mild-dip config unavailable: ${message.replace(/\s+/g, ' ').slice(0, 500)}`);
  }
}

function loadStateOrThrow(statePath: string) {
  try {
    if (!fs.existsSync(statePath)) throw new Error('state file does not exist');
    const state = loadMildDipState(statePath);
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { open?: unknown };
    if (!raw || typeof raw.open !== 'object' || raw.open == null || Array.isArray(raw.open)) {
      throw new Error('state.open is missing');
    }
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`state unavailable at ${statePath}: ${message}`);
  }
}

async function quoteExit(
  runtime: Runtime,
  copyCfg: ReturnType<typeof mildDipToCopyTraderConfig>,
  mint: string,
  tokenRaw: string,
): Promise<QuoteResult | null> {
  const owner = copyCfg.walletPubkeyExpected?.trim();
  if (!owner) throw new Error('MILD_DIP_WALLET_PUBKEY is missing');
  const spec = copyQuoteSpec(copyCfg);
  const prep = await runtime.liveSellQuoteAndPrepareSnapshot({
    cfg: runtime.copyTraderLiveOscarBridge(copyCfg),
    inputMint: mint,
    tokenAmountRaw: tokenRaw,
    solUsd: 0,
    userPublicKey: owner,
    outputMintOverride: spec.mint,
  });
  if (!prep) return null;
  const quote = copySellQuotePriceUsd({
    spec,
    outAmountRaw: prep.quoteResponse.outAmount,
    tokenAmountRaw: tokenRaw,
    solUsd: 0,
  });
  return { estimatedUsd: quote.proceedsUsd, mark: quote.priceUsd };
}

async function classifyUnavailableQuote(
  runtime: Runtime,
  copyCfg: ReturnType<typeof mildDipToCopyTraderConfig>,
  mint: string,
  tokenRaw: string,
): Promise<'no_route' | 'quote_unavailable'> {
  const liveCfg = runtime.copyTraderLiveOscarBridge(copyCfg);
  const spec = copyQuoteSpec(copyCfg);
  const url = new URL(runtime.resolveLiveJupiterQuoteUrl(liveCfg));
  url.searchParams.set('inputMint', mint);
  url.searchParams.set('outputMint', spec.mint);
  url.searchParams.set('amount', tokenRaw);
  url.searchParams.set('slippageBps', String(liveCfg.liveDefaultSlippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), liveCfg.liveJupiterQuoteTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: runtime.jupiterJsonHeaders(),
    });
  } finally {
    clearTimeout(timeout);
  }
  let raw: Record<string, unknown> | null = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      raw = body as Record<string, unknown>;
    }
  } catch {
    raw = null;
  }
  if (raw?.errorCode === 'NO_ROUTES_FOUND' || raw?.error === 'No routes found') {
    return 'no_route';
  }
  if (!response.ok) {
    return 'quote_unavailable';
  }
  return 'quote_unavailable';
}

function printLine(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
    loadLaneEnvironment(options.lane);
  } catch (error) {
    console.error(`[milddip-force-exit] ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(1);
  }

  const cfg = loadConfigOrThrow();
  if (cfg.executionMode !== 'live') {
    throw new Error(`live mode required; current execution mode is ${cfg.executionMode}`);
  }
  let runtime: Runtime;
  try {
    const [executor, liveExec, liveBridge, jupiter, jupiterHttp, orphanJanitor] =
      await Promise.all([
      import('../src/copytrader/executor.js'),
      import('../src/copytrader/live-exec.js'),
      import('../src/copytrader/live-bridge.js'),
      import('../src/live/jupiter.js'),
      import('../src/core/jupiter-http.js'),
      import('../src/milddip/orphan-janitor.js'),
      ]);
    runtime = {
      executeCopySell: executor.executeCopySell,
      fetchMintBalanceRaw: liveExec.fetchMintBalanceRaw,
      copyTraderLiveOscarBridge: liveBridge.copyTraderLiveOscarBridge,
      liveSellQuoteAndPrepareSnapshot: jupiter.liveSellQuoteAndPrepareSnapshot,
      resolveLiveJupiterQuoteUrl: jupiter.resolveLiveJupiterQuoteUrl,
      jupiterJsonHeaders: jupiterHttp.jupiterJsonHeaders,
      listOrphanTokenAccounts: orphanJanitor.listOrphanTokenAccounts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`live execution dependencies unavailable: ${message.replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  const copyCfg = mildDipToCopyTraderConfig(cfg);
  const state = loadStateOrThrow(cfg.statePath);
  const openMints = new Set(Object.keys(state.open ?? {}));

  let candidates: string[];
  if (options.mode === 'orphans') {
    const owner = cfg.walletPubkeyExpected?.trim();
    if (!owner) throw new Error('MILD_DIP_WALLET_PUBKEY is missing');
    const rows = await runtime.listOrphanTokenAccounts({
      rpcUrl: cfg.rpcUrl,
      owner,
      protectMints: options.includeManaged ? [] : openMints,
    });
    candidates = [...new Set(rows.map((row) => row.mint))];
  } else {
    candidates = [...new Set(options.mints.map((mint) => mint.trim()).filter(Boolean))];
  }

  if (candidates.length === 0) {
    printLine({
      summary: true,
      lane: options.lane,
      dryRun: !options.execute,
      sold: 0,
      skipped: 0,
      totalReceivedUsd: 0,
      totalEstimatedUsd: 0,
      reason: 'no_candidates',
    });
    return;
  }

  let sold = 0;
  let skipped = 0;
  let totalReceivedUsd = 0;
  let totalEstimatedUsd = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const mint = candidates[index];
    if (index >= options.maxSales) {
      skipped += 1;
      printLine({ mint, estimatedUsd: null, ok: false, signature: null, reason: 'max_sales_reached' });
      continue;
    }
    if (PROTECTED_MINTS.has(mint)) {
      skipped += 1;
      printLine({ mint, estimatedUsd: null, ok: false, signature: null, reason: 'protected_mint' });
      continue;
    }
    if (openMints.has(mint) && !options.includeManaged) {
      skipped += 1;
      printLine({ mint, estimatedUsd: null, ok: false, signature: null, reason: 'managed_mint_requires_include_managed' });
      continue;
    }

    let balanceRaw: string | null;
    try {
      balanceRaw = await runtime.fetchMintBalanceRaw(copyCfg, mint);
    } catch (error) {
      skipped += 1;
      printLine({
        mint,
        estimatedUsd: null,
        ok: false,
        signature: null,
        reason: `balance_read_failed:${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const onchainRaw = balanceRaw && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : 0n;
    if (onchainRaw <= HOLDING_DUST_RAW) {
      skipped += 1;
      printLine({ mint, estimatedUsd: null, ok: false, signature: null, reason: 'onchain_balance_at_or_below_dust' });
      continue;
    }

    let quote: QuoteResult | null;
    try {
      quote = await quoteExit(runtime, copyCfg, mint, onchainRaw.toString());
    } catch (error) {
      skipped += 1;
      printLine({
        mint,
        estimatedUsd: null,
        ok: false,
        signature: null,
        reason: `quote_failed:${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!quote) {
      skipped += 1;
      let reason: 'no_route' | 'quote_unavailable' = 'quote_unavailable';
      try {
        reason = await classifyUnavailableQuote(runtime, copyCfg, mint, onchainRaw.toString());
      } catch {
        /* Preserve the generic unavailable classification when diagnosis fails. */
      }
      printLine({ mint, estimatedUsd: null, ok: false, signature: null, reason });
      continue;
    }
    totalEstimatedUsd += quote.estimatedUsd;
    if (quote.estimatedUsd < options.minValueUsd) {
      skipped += 1;
      printLine({
        mint,
        estimatedUsd: quote.estimatedUsd,
        mark: quote.mark,
        ok: false,
        signature: null,
        reason: `below_min_value_usd:${quote.estimatedUsd.toFixed(4)}<${options.minValueUsd}`,
      });
      continue;
    }

    if (!options.execute) {
      printLine({
        mint,
        estimatedUsd: quote.estimatedUsd,
        mark: quote.mark,
        ok: true,
        signature: null,
        reason: 'dry_run',
      });
    } else {
      try {
        const result = await runtime.executeCopySell({
          cfg: copyCfg,
          mint,
          symbol: mint.slice(0, 6),
          entryPriceUsd: 0,
          exitPriceUsd: quote.mark,
          sizeUsd: quote.estimatedUsd,
          fraction: 1,
          leaderSignature: `milddip_manual_force_exit_${Date.now()}`,
          sellDelayMs: 0,
          tokenRawBase: onchainRaw.toString(),
        });
        if (result.ok) {
          sold += 1;
          totalReceivedUsd += result.quoteReceivedUsd ?? 0;
        } else {
          skipped += 1;
        }
        printLine({
          mint,
          estimatedUsd: quote.estimatedUsd,
          mark: result.priceUsd || quote.mark,
          ok: result.ok,
          signature: result.signature ?? null,
          reason: result.ok ? 'manual_force_exit' : result.reason ?? 'sell_failed',
        });
      } catch (error) {
        skipped += 1;
        printLine({
          mint,
          estimatedUsd: quote.estimatedUsd,
          mark: quote.mark,
          ok: false,
          signature: null,
          reason: `sell_failed:${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (index + 1 < candidates.length && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  printLine({
    summary: true,
    lane: options.lane,
    dryRun: !options.execute,
    sold,
    skipped,
    totalReceivedUsd,
    totalEstimatedUsd,
  });
}

main().catch((error) => {
  console.error(`[milddip-force-exit] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
