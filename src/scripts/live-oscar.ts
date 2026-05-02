import { main } from '../live/main.js';

try {
  main();
} catch (err) {
  console.error('live-oscar fatal', err);
  process.exit(1);
}
