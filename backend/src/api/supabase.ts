import { createServerClient } from "@supabase/ssr";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { anonKey, supabaseUrl } from "@/lib/env";
import { config } from "./config";

export { kioskClient } from "@/lib/supabase";

/**
 * Supabase client bound to the admin's session cookie, for the /v1/auth and /v1/admin API routes
 * (the admin portal's own pages use lib/supabase.ts). Refreshed session cookies go on this
 * response, httpOnly: only the server ever reads them.
 */
export function adminClient(c: Context) {
  return createServerClient(supabaseUrl(), anonKey(), {
    cookies: {
      getAll: () => Object.entries(getCookie(c)).map(([name, value]) => ({ name, value })),
      setAll: (toSet) => {
        // Same as the admin portal's (lib/admin-session.ts): hardened, and gone when the browser closes.
        for (const { name, value, options } of toSet) {
          setCookie(c, name, value, {
            path: "/",
            ...(options?.maxAge === 0 ? { maxAge: 0 } : {}),
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: "Lax",
          });
        }
      },
    },
  });
}
