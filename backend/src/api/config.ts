// Settings that aren't secrets. Secrets (Supabase, R2, Resend) are read where they're used, in lib/.

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  /**
   * Browser origins allowed to call the API directly (CORS), e.g. "https://www.awign.com".
   * Empty = none: the website and the admin console reach the API through their own server
   * (a same-origin proxy), which needs no CORS at all. Only set this if a browser calls the API's own address.
   */
  corsOrigins: list(process.env.CORS_ORIGINS),
  /** Mark the admin session cookie Secure (HTTPS only). On by default; turn off only for local http. */
  cookieSecure: process.env.COOKIE_SECURE !== "false",
  /** Behind a load balancer / proxy that sets X-Forwarded-For: trust it for the client IP (rate limits). */
  trustProxy: process.env.TRUST_PROXY !== "false",
  /** Request submissions allowed per client IP per window. */
  submitLimit: num(process.env.SUBMIT_LIMIT, 10),
  submitWindowMs: num(process.env.SUBMIT_WINDOW_S, 600) * 1000,
  /** How long the inventory (hours per environment / skill) is kept before asking Supabase again. */
  inventoryTtlMs: num(process.env.INVENTORY_TTL_S, 300) * 1000,
};
