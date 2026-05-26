import { runParser } from '../parser/index.js';

runParser().catch((err) => {
  console.error('[sa-parser] fatal', err);
  process.exit(1);
});
