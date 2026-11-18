import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SEEN_COOKIE, seenCookie, seenCookieCleared, sessionCookieOptions, stillFresh } from "@/lib/admin-session";
import { anonKey, supabaseUrl } from "@/lib/env";

// Keeps signed-out users on the login page, refreshes the admin session, and ends it when the
// visit ends: after ADMIN_IDLE_MINUTES without a page load (or a closed browser) the admin must
// sign in again. See lib/admin-session.ts.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), anonKey(), {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, sessionCookieOptions(options)));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A session left idle too long ends here: signed out on this device only (not the admin's other
  // devices), and the next screen is the login page.
  let signedIn = !!user;
  let expired = false;
  if (user && !stillFresh(request.cookies.get(SEEN_COOKIE)?.value)) {
    await supabase.auth.signOut({ scope: "local" });
    signedIn = false;
    expired = true;
  }

  const isLogin = request.nextUrl.pathname === "/admin/login";
  // Whatever response goes out carries the session cookies set above and the "last seen" time.
  const finish = (res: NextResponse) => {
    if (res !== response) for (const c of response.cookies.getAll()) res.cookies.set(c);
    if (signedIn && !isLogin) res.cookies.set(seenCookie());
    if (expired) res.cookies.set(seenCookieCleared());
    return res;
  };

  if (!signedIn && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    if (expired) url.searchParams.set("expired", "1");
    return finish(NextResponse.redirect(url));
  }
  if (signedIn && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return finish(NextResponse.redirect(url));
  }
  return finish(response);
}

export const config = {
  matcher: ["/admin/:path*"],
};
