/**
 * Enqueue explicit mints into `signatures_seed_queue` for `npm run sigseed:run`.
 *
 *   npm run sigseed:enqueue-mints -- --from-dip-anchor-gaps
 *   npm run sigseed:enqueue-mints -- --mints=Mint1,Mint2
 *   npm run dip-bot-intel:anchor-gaps | npm run sigseed:enqueue-mints -- --stdin
 *
 * Does not require SA_SIGSEED_ENQUEUE_ENABLED (operational backfill path).
 */
import { sql } from '../core/db/client.js';

const HIGH_PRIORITY = 98;

function parseArgs(): {
  fromGaps: boolean;
  stdin: boolean;
  mintsCsv: string | null;
  dryRun: boolean;
  priority: number;
} {
  const argv = process.argv.slice(2);
  let fromGaps = false;
  let stdin = false;
  let mintsCsv: string | null = null;
  let dryRun = false;
  let priority = HIGH_PRIORITY;
  for (const a of argv) {
    if (a === '--from-dip-anchor-gaps') fromGaps = true;
    else if (a === '--stdin') stdin = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--mints=')) mintsCsv = a.slice('--mints='.length).trim();
    else if (a.startsWith('--priority=')) {
      const n = Number(a.slice('--priority='.length));
      if (Number.isFinite(n)) priority = Math.floor(n);
    }
  }
  return { fromGaps, stdin, mintsCsv, dryRun, priority };
}

async function mintsFromAnchorGaps(): Promise<string[]> {
  const rows = await sql<{ anchor_mint: string }[]>`
    SELECT DISTINCT anchor_mint::text
    FROM dip_bot_intel_anchors_processed
    WHERE buyer_rows = 0
    ORDER BY anchor_mint ASC
  `;
  return rows.map((r) => String(r.anchor_mint || '').trim()).filter(Boolean);
}

async function readStdinMints(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return [];
  const j = JSON.parse(raw) as { mints?: unknown };
  const list = Array.isArray(j.mints) ? j.mints : [];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

function parseCsvMints(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function enqueueMint(mint: string, priority: number, dryRun: boolean): Promise<boolean> {
  if (dryRun) return true;
  await sql`
    INSERT INTO signatures_seed_queue (mint, priority, status)
    VALUES (${mint}, ${priority}, 'pending')
    ON CONFLICT (mint) DO UPDATE SET
      priority = GREATEST(signatures_seed_queue.priority, EXCLUDED.priority),
      status = CASE
        WHEN signatures_seed_queue.status = 'error' THEN 'pending'
        ELSE signatures_seed_queue.status
      END,
      error_message = CASE
        WHEN signatures_seed_queue.status = 'error' THEN NULL
        ELSE signatures_seed_queue.error_message
      END
  `;
  return true;
}

async function main(): Promise<void> {
  const { fromGaps, stdin, mintsCsv, dryRun, priority } = parseArgs();
  let mints: string[] = [];
  if (stdin) mints = await readStdinMints();
  else if (mintsCsv) mints = parseCsvMints(mintsCsv);
  else if (fromGaps) mints = await mintsFromAnchorGaps();
  else {
    console.error(
      '[sigseed-enqueue-mints] specify --from-dip-anchor-gaps | --mints=a,b | pipe JSON with mints[] via --stdin',
    );
    process.exitCode = 1;
    return;
  }

  const seen = new Set<string>();
  const unique = mints.filter((m) => {
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });

  let ok = 0;
  for (const mint of unique) {
    await enqueueMint(mint, priority, dryRun);
    ok++;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        component: 'sigseed-enqueue-mints',
        dryRun,
        priority,
        requested: mints.length,
        distinctEnqueued: ok,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('[sigseed-enqueue-mints] fatal', e);
  process.exit(1);
});
