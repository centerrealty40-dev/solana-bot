import { main } from '../papertrader/main.js';

main().catch((err) => {
  console.error('papertrader fatal', err);
  process.exit(1);
});
