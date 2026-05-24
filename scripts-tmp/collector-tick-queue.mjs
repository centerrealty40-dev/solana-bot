/**
 * Serial collector ticks with catch-up for skipped minute buckets when a tick overruns INTERVAL_MS.
 */

/**
 * @param {object} args
 * @param {(level: string, message: string, meta?: object) => void} args.log
 * @param {(bucketTs: Date) => Promise<void>} args.runCollectForBucket
 * @param {(ts?: number) => Date} args.getMinuteBucketUtc
 */
export function createCollectorTickRunner({ log, runCollectForBucket, getMinuteBucketUtc }) {
  let isTickRunning = false;
  /** @type {Date[]} */
  let pendingBuckets = [];

  /** @param {Date} d */
  function bucketKey(d) {
    return d.getTime();
  }

  /** @param {Date} bucketTs */
  function queueBucket(bucketTs) {
    const key = bucketKey(bucketTs);
    if (!pendingBuckets.some((b) => bucketKey(b) === key)) {
      pendingBuckets.push(bucketTs);
    }
  }

  async function runTickGuarded() {
    const triggerBucket = getMinuteBucketUtc();
    if (isTickRunning) {
      queueBucket(triggerBucket);
      log('warn', 'skipping tick, previous run still active — queued bucket', {
        bucketTs: triggerBucket.toISOString(),
        pending: pendingBuckets.length,
      });
      return;
    }

    isTickRunning = true;
    try {
      /** @type {Set<number>} */
      const seen = new Set();
      /** @type {Date[]} */
      const buckets = [triggerBucket, ...pendingBuckets];
      pendingBuckets = [];

      for (const bucket of buckets) {
        const key = bucketKey(bucket);
        if (seen.has(key)) continue;
        seen.add(key);
        await runCollectForBucket(bucket);
      }

      const latest = getMinuteBucketUtc();
      const latestKey = bucketKey(latest);
      if (!seen.has(latestKey)) {
        await runCollectForBucket(latest);
        seen.add(latestKey);
      }
    } finally {
      isTickRunning = false;
      if (pendingBuckets.length > 0) {
        setImmediate(() => void runTickGuarded());
      }
    }
  }

  return { runTickGuarded };
}
