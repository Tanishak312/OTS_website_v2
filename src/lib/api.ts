import "server-only";
import { headers } from "next/headers";

// The website's only way to data: the backend (./backend, its /v1 API). This server never talks to
// Supabase, R2 or Resend itself and holds none of their keys; it needs only OTS_API_URL, the
// backend's address as this server reaches it (a private address in production).

export function apiBase(): string {
  const url = process.env.OTS_API_URL?.trim();
  if (!url) throw new Error("OTS_API_URL is not set: the backend's address (see .env.example)");
  return url.replace(/\/+$/, "");
}

type ApiInit = {
  method?: "GET" | "POST";
  body?: unknown;
  /** Give up if the backend hasn't started answering by then. The body, once it flows, is not cut. */
  timeoutMs?: number;
  /** Extra request headers, e.g. the visitor's IP (see visitorHeaders). */
  headers?: Record<string, string>;
};

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

/**
 * The visitor's address: the right-most PUBLIC entry of X-Forwarded-For. Each proxy appends the
 * address it saw, so that is the one our own load balancer added; entries to its left came from
 * the visitor and can be made up. (All private = a local run: the right-most entry.)
 */
function visitorIp(xff: string | null, realIp: string | null): string | null {
  const hops = (xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!PRIVATE.test(hops[i])) return hops[i];
  return hops[hops.length - 1] ?? realIp?.trim() ?? null;
}

/**
 * Headers for calls made on a visitor's behalf (the request form): the shared OTS_INTERNAL_KEY,
 * which the backend requires before it accepts a submission, and the visitor's address for its
 * per-visitor limit (without it every visitor would look like this server, and ten submissions
 * site-wide would lock everyone out).
 */
export async function visitorHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = {};
  const key = process.env.OTS_INTERNAL_KEY?.trim();
  if (key) out["x-ots-internal-key"] = key;
  const ip = visitorIp(h.get("x-forwarded-for"), h.get("x-real-ip"));
  if (ip) out["x-ots-client-ip"] = ip;
  return out;
}

/** Calls the backend. Never throws for an HTTP error: returns the Response, so callers handle 4xx themselves. */
export async function api(path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), init.timeoutMs ?? 15_000);
  try {
    return await fetch(apiBase() + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: giveUp.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The JSON body's `error`, or a fallback written for people. */
export async function apiError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

// What a proxied response may carry back to the browser.
const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag", "cache-control", "content-disposition", "x-content-type-options"];

/** Streams a backend response straight through (preview videos): status, the headers above, and the body as it arrives. */
export async function proxy(request: Request, path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const h of ["range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), 15_000);
  let upstream: Response;
  try {
    upstream = await fetch(apiBase() + path, { method: request.method === "HEAD" ? "HEAD" : "GET", headers, cache: "no-store", signal: giveUp.signal });
  } catch (e) {
    console.error("[api proxy]", path.split("?")[0], e instanceof Error ? e.name : "error");
    return new Response("Unavailable", { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } finally {
    clearTimeout(timer);
  }
  const out = new Headers();
  for (const h of PASS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}
