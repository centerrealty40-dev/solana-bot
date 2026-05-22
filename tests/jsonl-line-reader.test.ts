import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { iterJsonlLines } from '../scripts-tmp/jsonl-line-reader.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('iterJsonlLines', () => {
  it('reads all lines from a multi-chunk file without loading whole file as one string', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-read-'));
    const fp = path.join(tmpDir, 'big.jsonl');
    const rows: string[] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push(JSON.stringify({ i, pad: 'x'.repeat(200) }));
    }
    fs.writeFileSync(fp, `${rows.join('\n')}\n`, 'utf8');

    const lines = [...iterJsonlLines(fp)];
    expect(lines.length).toBe(5000);
    expect(JSON.parse(lines[0]!).i).toBe(0);
    expect(JSON.parse(lines.at(-1)!).i).toBe(4999);
  });
});
