/**
 * Bounded journal reads must never hand V8 a string it cannot build.
 *
 * `LIVE_SLIPPAGE_MAX_JOURNAL_BYTES` is operator-supplied and was set above the 512 MB string
 * limit, so the slippage report died with `ERR_STRING_TOO_LONG` on the 2.57 GB live journal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JOURNAL_MAX_DECODE_BYTES,
  iterateBoundedJournalLines,
  readLiveJournalLinesBounded,
} from '../../src/live/replay-strategy-journal.js';

describe('bounded journal reads', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    tmpFiles.length = 0;
  });

  function writeJournal(lines: string[]): string {
    const fp = path.join(os.tmpdir(), `journal-bounded-${Date.now()}-${Math.random()}.jsonl`);
    fs.writeFileSync(fp, `${lines.join('\n')}\n`, 'utf8');
    tmpFiles.push(fp);
    return fp;
  }

  it('caps the decode window below the V8 string limit', () => {
    expect(JOURNAL_MAX_DECODE_BYTES).toBeLessThan(512 * 1024 * 1024);
  });

  it('reads a small file whole even when the caller passes an oversized limit', () => {
    const fp = writeJournal(['{"a":1}', '{"a":2}', '{"a":3}']);
    const { lines, truncated } = readLiveJournalLinesBounded(fp, 2_700_000_000);
    expect(truncated).toBe(false);
    expect(lines.filter((l) => l.trim().length > 0)).toHaveLength(3);
  });

  it('falls back to a tail read when the limit exceeds the decode cap', () => {
    const fp = writeJournal(['{"a":1}', '{"a":2}', '{"a":3}']);
    const seen: string[] = [];
    const { truncated } = iterateBoundedJournalLines(fp, 12, (line) => {
      if (line.trim().length > 0) seen.push(line);
    });
    expect(truncated).toBe(true);
    expect(seen).toEqual(['{"a":3}']);
  });
});
