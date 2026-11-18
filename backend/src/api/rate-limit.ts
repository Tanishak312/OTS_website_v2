import type { Context } from "hono";
import { config } from "./config";

// A fixed window per client, in memory. Enough to stop one script from flooding the request form.
// Each server copy counts on its own, so with N copies the real limit is up to N times this; when
// that matters it moves to Redis.

const windows = new Map<string, { start: number; count: number }>();

/** The visitor's IP: the first X-Forwarded-For hop when behind a proxy we trust, else X-Real-IP. */
export function clientIp(c: Context): string {
  if (config.trustProxy) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return c.req.header("x-real-ip")?.trim() || "unknown";
}

/** true if this client may go ahead; counts the attempt. */
export function allow(bucket: string, key: string, limit: number, windowMs: number): boolean {
  const id = `${bucket}:${key}`;
  const now = Date.now();
  const w = windows.get(id);
  if (!w || now - w.start >= windowMs) {
    windows.set(id, { start: now, count: 1 });
    if (windows.size > 50_000) sweep(now, windowMs);
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

function sweep(now: number, windowMs: number) {
  for (const [id, w] of windows) if (now - w.start >= windowMs) windows.delete(id);
}
