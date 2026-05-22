/**
 * Stream-read JSONL without loading the whole file into one string (Node ~512MB limit).
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 1024 * 1024;

/** Yield trimmed non-empty lines from a JSONL file (sync, bounded memory). */
export function* iterJsonlLines(filePath: string): Generator<string> {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  try {
    let pos = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      carry += decoder.write(buf.subarray(0, bytesRead));
      let nl = carry.indexOf('\n');
      while (nl >= 0) {
        const line = carry.slice(0, nl).trim();
        if (line) yield line;
        carry = carry.slice(nl + 1);
        nl = carry.indexOf('\n');
      }
    }
    carry += decoder.end();
    const tail = carry.trim();
    if (tail) yield tail;
  } finally {
    fs.closeSync(fd);
  }
}

export function forEachJsonlLineSync(filePath: string, fn: (line: string) => void): void {
  for (const line of iterJsonlLines(filePath)) fn(line);
}
