/**
 * Stream-read JSONL without loading the whole file into one string (Node ~512MB limit).
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 1024 * 1024;

function* yieldLinesFromCarry(carry: string, decoder: StringDecoder, done: boolean): Generator<string> {
  let buf = carry;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      if (line) yield line;
      buf = buf.slice(nl + 1);
      continue;
    }
    if (!done) break;
    buf += decoder.end();
    const tail = buf.trim();
    if (tail) yield tail;
    break;
  }
}

function* iterJsonlLinesFromOffset(filePath: string, startOffset: number): Generator<string> {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  try {
    let pos = Math.max(0, startOffset);
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (bytesRead <= 0) {
        yield* yieldLinesFromCarry(carry, decoder, true);
        break;
      }
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
  } finally {
    fs.closeSync(fd);
  }
}

/** Yield trimmed non-empty lines from a JSONL file (sync, bounded memory). */
export function* iterJsonlLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesFromOffset(filePath, 0);
}

/**
 * Read only the trailing `maxTailBytes` of a JSONL file (skips the first partial line after seek).
 * Matches live-oscar journal replay truncation for dashboard speed on multi-hundred-MB journals.
 */
export function* iterJsonlTailLines(filePath: string, maxTailBytes: number): Generator<string> {
  const st = fs.statSync(filePath);
  if (st.size <= maxTailBytes) {
    yield* iterJsonlLines(filePath);
    return;
  }
  const startOffset = st.size - maxTailBytes;
  let skippedFirst = false;
  for (const line of iterJsonlLinesFromOffset(filePath, startOffset)) {
    if (!skippedFirst) {
      skippedFirst = true;
      continue;
    }
    yield line;
  }
}

/** Full scan for small files; tail-only when file exceeds `maxTailBytes`. */
export function* iterJsonlLinesBounded(
  filePath: string,
  maxTailBytes: number,
  fullScanMaxBytes = maxTailBytes,
): Generator<string> {
  const size = fs.statSync(filePath).size;
  if (size <= fullScanMaxBytes) {
    yield* iterJsonlLines(filePath);
    return;
  }
  yield* iterJsonlTailLines(filePath, maxTailBytes);
}

export function forEachJsonlLineSync(filePath: string, fn: (line: string) => void): void {
  for (const line of iterJsonlLines(filePath)) fn(line);
}
