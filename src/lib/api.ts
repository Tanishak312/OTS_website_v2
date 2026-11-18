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

/**
 * The visitor's address, for calls made on a visitor's behalf (the request form). The backend
 * limits submissions per visitor; without this every visitor would look like this server, and
 * ten submissions site-wide would lock everyone out for ten minutes.
 */
export async function visitorHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = {};
  const fwd = h.get("x-forwarded-for");
  const real = h.get("x-real-ip");
  if (fwd) out["x-forwarded-for"] = fwd;
  if (real) out["x-real-ip"] = real;
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
