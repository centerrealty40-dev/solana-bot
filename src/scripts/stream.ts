import { runStream } from '../stream/index.js';

runStream().catch((err) => {
  console.error('[sa-stream] fatal', err);
  process.exit(1);
});
