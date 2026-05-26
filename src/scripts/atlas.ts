import { runAtlas } from '../atlas/index.js';

runAtlas().catch((err) => {
  console.error('[sa-atlas] fatal', err);
  process.exit(1);
});
