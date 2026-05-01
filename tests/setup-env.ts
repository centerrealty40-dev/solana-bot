/** Minimal env so core/logger → config loads in Vitest without dotenv. */
process.env.DATABASE_URL ||= 'postgresql://u:p@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
