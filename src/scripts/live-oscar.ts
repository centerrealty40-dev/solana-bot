import { main } from '../live/main.js';

main().catch((err) => {
  console.error('live-oscar fatal', err);
  process.exit(1);
});
