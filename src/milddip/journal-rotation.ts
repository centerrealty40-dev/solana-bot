import fs from 'node:fs';
import zlib from 'node:zlib';

export function rotateMildDipJournal(filePath: string, maxBytes: number): boolean {
  if (!(maxBytes > 0)) return false;
  try {
    if (fs.statSync(filePath).size <= maxBytes) return false;
    let suffix = 0;
    let rotated: string;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    do {
      suffix += 1;
      rotated = `${filePath}.${date}.${suffix}.jsonl`;
    } while (fs.existsSync(rotated));
    fs.renameSync(filePath, rotated);
    try {
      fs.writeFileSync(`${rotated}.gz`, zlib.gzipSync(fs.readFileSync(rotated)));
      fs.unlinkSync(rotated);
    } catch {
      /* The append path remains available even if compression fails. */
    }
    return true;
  } catch {
    return false;
  }
}
