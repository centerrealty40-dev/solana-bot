import fs from 'node:fs';
import path from 'node:path';

export type OpsHeartbeatOptions = {
  appName: string;
  intervalMs?: number;
  filePath?: string;
  stats?: () => Record<string, unknown>;
};

export function opsHeartbeatPath(appName: string): string {
  const dir =
    process.env.OPS_HEARTBEAT_DIR?.trim() ||
    path.join(process.cwd(), 'data/ops-heartbeats');
  return path.join(dir, `${appName}.json`);
}

export function writeOpsHeartbeat(
  appName: string,
  stats?: Record<string, unknown>,
  filePath?: string,
): void {
  const p = filePath ?? opsHeartbeatPath(appName);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `${JSON.stringify({ ts: Date.now(), app: appName, ...stats })}\n`,
    'utf8',
  );
}

/** PM2 watchdog liveness file (default every 60s). */
export function startOpsHeartbeat(opts: OpsHeartbeatOptions): () => void {
  const intervalMs = Math.max(15_000, opts.intervalMs ?? 60_000);
  const tick = (): void => {
    try {
      writeOpsHeartbeat(opts.appName, opts.stats?.(), opts.filePath);
    } catch {
      // ignore heartbeat write errors
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function writeOpsFatal(
  appName: string,
  source: string,
  err: unknown,
  filePath?: string,
): void {
  const p =
    filePath ??
    path.join(
      process.env.OPS_HEARTBEAT_DIR?.trim() ||
        path.join(process.cwd(), 'data/ops-heartbeats'),
      `${appName}-last-fatal.json`,
    );
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const message = err instanceof Error ? err.stack || err.message : String(err);
    fs.writeFileSync(
      p,
      `${JSON.stringify({ ts: Date.now(), app: appName, source, message: message.slice(0, 2000) })}\n`,
      'utf8',
    );
  } catch {
    // ignore
  }
}
