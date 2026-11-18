import type { CookieOptions } from "@supabase/ssr";
import { config } from "@/api/config";

// How the admin portal's sign-in is kept, so a session ends with the visit:
//
//   - Supabase's session cookies are browser-session cookies (no expiry date): closing the browser
//     ends them. Supabase on its own keeps them for 400 days.
//   - ots_admin_seen holds the time of the last admin page load. When it's older than
//     ADMIN_IDLE_MINUTES (default 10), or missing, the next page load signs the admin out and asks
//     for the password again.
//   - All of them are httpOnly (page scripts can't read the session), Secure unless COOKIE_SECURE
//     is false (local http only), and SameSite=Lax.

export const SEEN_COOKIE = "ots_admin_seen";
const IDLE_MS = config.adminIdleMinutes * 60_000;

const base = () => ({ path: "/", sameSite: "lax" as const, httpOnly: true, secure: config.cookieSecure });

/** Options for a Supabase session cookie: hardened, and without an expiry unless it's being deleted. */
export function sessionCookieOptions(options?: Partial<CookieOptions>) {
  return options?.maxAge === 0 ? { ...base(), maxAge: 0 } : base();
}

/** The "last seen" cookie, set to now. */
export function seenCookie(now = Date.now()) {
  return { name: SEEN_COOKIE, value: String(now), ...base() };
}

/** Deletes the "last seen" cookie. */
export function seenCookieCleared() {
  return { name: SEEN_COOKIE, value: "", ...base(), maxAge: 0 };
}

/** true if the last admin page load was recent enough to keep the session. */
export function stillFresh(value: string | undefined, now = Date.now()): boolean {
  const at = Number(value);
  return Number.isFinite(at) && at <= now + 60_000 && now - at < IDLE_MS;
}
