// A fixed window per client, in memory. Enough to stop one script from flooding the request form.
// Each server copy counts on its own, so with N copies the real limit is up to N times this; when
// that matters it moves to Redis. Who the client is: see client-ip.ts.

export { clientIp } from "./client-ip";

const windows = new Map<string, { start: number; count: number }>();

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
