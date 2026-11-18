import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "./config";

// Who is calling, for the per-visitor limits.
//
// The request form reaches this API from the OTS website's server, never from a browser. The
// website proves it with the shared OTS_INTERNAL_KEY and says which visitor it is acting for
// (X-OTS-Client-IP). Anyone else gets the address from X-Forwarded-For, read from the right: each
// proxy appends the address it saw, so the right-most PUBLIC entry is the one our own load balancer
// added. Entries further left came from the caller and can be made up.

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

/** The right-most public address in an X-Forwarded-For chain; the right-most entry if all are private (local runs). */
export function addressFromForwarded(xff: string | undefined | null): string | null {
  const hops = (xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!PRIVATE.test(hops[i])) return hops[i];
  return hops[hops.length - 1] ?? null;
}

/** true when the caller is the OTS website's server (it holds OTS_INTERNAL_KEY). */
export function isInternal(c: Context): boolean {
  const want = config.internalKey;
  const got = c.req.header("x-ots-internal-key");
  if (!want || !got) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clientIp(c: Context): string {
  if (isInternal(c)) {
    const ip = c.req.header("x-ots-client-ip")?.trim();
    if (ip) return ip;
  }
  return addressFromForwarded(c.req.header("x-forwarded-for")) ?? c.req.header("x-real-ip")?.trim() ?? "unknown";
}
