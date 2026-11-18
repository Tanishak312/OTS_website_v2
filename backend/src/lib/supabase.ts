import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sessionCookieOptions } from "./admin-session";
import { anonKey, supabaseUrl } from "./env";

/** Stateless anon client for kiosk submissions. */
export function kioskClient() {
  return createClient(supabaseUrl(), anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Cookie-bound client for admin pages and server actions. */
export async function adminClient() {
  const store = await cookies();
  return createServerClient(supabaseUrl(), anonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          // Hardened and expiry-less: the session ends with the visit (lib/admin-session.ts).
          toSet.forEach(({ name, value, options }) => store.set(name, value, sessionCookieOptions(options)));
        } catch {
          // Called from a server component, where cookies are read-only. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}
