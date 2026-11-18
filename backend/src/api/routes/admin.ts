import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { domainName, skillName } from "@/lib/catalog";
import { cleanAccess, emailBucketAccess, emailCustomer, validateAccess } from "@/lib/delivery";
import { csvCell, episodeFiles } from "@/lib/episode-files";
import type { BreakdownEnvironment } from "@/lib/selection";
import { sampleByBucket, type OtsEvent, type OtsRequest, type RequestStatus } from "@/lib/status";
import { allow, clientIp } from "@/api/rate-limit";
import { adminClient } from "@/api/supabase";

type Env = { Variables: { supabase: ReturnType<typeof adminClient>; email: string | null } };

const NO_STORE = { "cache-control": "no-store" };

// ---------------------------------------------------------------------------------------------
// Sign in / out. The session lives in httpOnly cookies set on this API's responses; the admin
// console's server passes them through (it proxies /api/* here), so the browser never holds a token
// a script could read.

export const authRoutes = new Hono();

authRoutes.post("/login", async (c) => {
  // Slows password guessing; the Supabase project has its own limit on top.
  if (!allow("login", clientIp(c), 10, 10 * 60_000)) {
    return c.json({ error: "Too many tries. Wait a few minutes, then try again." }, 429, NO_STORE);
  }
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return c.json({ error: "Enter your email and password." }, 400, NO_STORE);

  // It has to stay a real Supabase sign-in: the database decides what an admin can read.
  const supabase = adminClient(c);
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "invalid_credentials") return c.json({ error: "That email and password don't match an admin account." }, 401, NO_STORE);
    console.error("[login] sign-in failed", { code: error.code, status: error.status, message: error.message });
    return c.json(
      { error: error.status === 429 ? "Too many tries. Wait a few minutes, then try again." : `Couldn't sign in (${error.message}).` },
      error.status === 429 ? 429 : 502,
      NO_STORE,
    );
  }

  // A failed check and a "no" are different problems; don't report one as the other.
  const { data: isAdmin, error: checkError } = await supabase.rpc("is_ots_admin");
  if (checkError) {
    console.error("[login] is_ots_admin failed", { user: auth.user?.id, code: checkError.code, message: checkError.message });
    await supabase.auth.signOut();
    return c.json(
      {
        error:
          checkError.code === "PGRST202" || checkError.code === "42883"
            ? "Admin check isn't set up in Supabase yet. Run supabase/001_init.sql, then try again."
            : `Couldn't check admin access (${checkError.code ?? "error"}: ${checkError.message}).`,
      },
      503,
      NO_STORE,
    );
  }
  if (!isAdmin) {
    console.warn("[login] signed in but not in ots_admins", { user: auth.user?.id });
    await supabase.auth.signOut();
    return c.json(
      { error: `${auth.user?.email ?? "This account"} can sign in, but it isn't on the OTS admin list yet. Add it to ots_admins (see README), then try again.` },
      403,
      NO_STORE,
    );
  }
  return c.json({ email: auth.user?.email ?? email }, 200, NO_STORE);
});

authRoutes.post("/logout", async (c) => {
  await adminClient(c).auth.signOut();
  return c.json({ ok: true }, 200, NO_STORE);
});

/** Who is signed in, or 401. Also refreshes the session cookies when they're close to expiring. */
authRoutes.get("/me", async (c) => {
  const { data } = await adminClient(c).auth.getUser();
  if (!data.user) return c.json({ error: "Not signed in." }, 401, NO_STORE);
  return c.json({ email: data.user.email ?? null }, 200, NO_STORE);
});

// ---------------------------------------------------------------------------------------------
// Admin data. Every route needs a signed-in user; what they can read and change is then decided
// by row-level security and the set_ots_* functions in Postgres, exactly as before the split.

export const adminRoutes = new Hono<Env>();

adminRoutes.use(
  createMiddleware<Env>(async (c, next) => {
    const supabase = adminClient(c);
    const { data } = await supabase.auth.getUser();
    if (!data.user) return c.json({ error: "Sign in again." }, 401, NO_STORE);
    c.set("supabase", supabase);
    c.set("email", data.user.email ?? null);
    await next();
    c.header("cache-control", "no-store");
  }),
);

// Kiosk volumes are small; load the newest rows and filter in memory so the KPI cards and the table always agree.
const LIST_LIMIT = 1000;

function explain(error: { code?: string; message?: string }): string {
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202") {
    return "The OTS tables aren't set up in Supabase yet. Run supabase/001_init.sql in the Supabase SQL editor, then reload.";
  }
  if (error.code === "42501") return "Your account isn't on the OTS admin list.";
  return error.message || "Couldn't load requests from Supabase.";
}

adminRoutes.get("/requests", async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("ots_requests")
    .select("*")
    .eq("is_demo", false) // The sample rows from 900_demo_seed.sql aren't real requests.
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) return c.json({ error: explain(error) }, 502);
  return c.json({ rows: data as OtsRequest[], truncated: data.length === LIST_LIMIT });
});

adminRoutes.get("/requests/:token", async (c) => {
  const supabase = c.get("supabase");
  const token = c.req.param("token");
  const { data, error } = await supabase.from("ots_requests").select("*").eq("token", token).maybeSingle();
  if (error) return c.json({ error: explain(error) }, 502);
  if (!data) return c.json({ error: `No request ${token}.` }, 404);
  const ev = await supabase
    .from("ots_request_events")
    .select("id, from_status, to_status, note, actor_email, created_at")
    .eq("request_id", data.id)
    .order("created_at", { ascending: true });
  if (ev.error) return c.json({ error: explain(ev.error) }, 502);
  return c.json({ request: data as OtsRequest, events: ev.data as OtsEvent[] });
});

// Not "approved": a dataset gets there by sending its bucket access.
const ALLOWED: RequestStatus[] = ["in_review", "rejected", "sample_sent"];

adminRoutes.post("/requests/:token/status", async (c) => {
  const token = c.req.param("token");
  const body = (await c.req.json().catch(() => null)) as { status?: unknown; note?: unknown } | null;
  const status = (typeof body?.status === "string" ? body.status : "") as RequestStatus;
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!ALLOWED.includes(status)) return c.json({ error: "Unknown action." }, 400);
  if (status === "rejected" && !note) return c.json({ error: "Add a note saying why this request is rejected." }, 400);

  const { error } = await c.get("supabase").rpc("set_ots_request_status", { p_token: token, p_status: status, p_note: note || null });
  if (error) {
    console.error("[status]", token, error.code, error.message);
    // Messages raised in set_ots_request_status are written for people.
    return c.json({ error: error.message || "Couldn't update the request. Try again." }, 409);
  }
  return c.json({ ok: true, status });
});

/** Row-level security returns nothing to anyone who isn't an admin, so a found request also means an admin asked. */
async function loadForEmail(c: Context<Env>, token: string) {
  const { data, error } = await c.get("supabase").from("ots_requests").select("*").eq("token", token).maybeSingle();
  if (error) console.error("[loadForEmail]", token, error.code, error.message);
  return data as OtsRequest | null;
}

/** Sends the automatic email again: the Drive link, the "being prepared" note, or the confirmation. */
adminRoutes.post("/requests/:token/resend-email", async (c) => {
  const token = c.req.param("token");
  const r = await loadForEmail(c, token);
  if (!r) return c.json({ error: `Couldn't load ${token}.` }, 404);
  const failed = await emailCustomer(c.get("supabase"), {
    token: r.token,
    kind: r.kind,
    email: r.email,
    name: r.full_name,
    setup: r.capture_setup,
    hours: r.matching_hours,
    bytes: r.matching_bytes,
  });
  if (failed) return c.json({ error: `It didn't go out: ${failed}` }, 502);
  return c.json({ ok: true });
});

/**
 * Emails the customer the keys to the bucket an admin filled, then marks the request done. The
 * email comes first: a failure leaves the request as it was. The secret goes in the email and
 * nowhere else; it's never stored or logged.
 */
adminRoutes.post("/requests/:token/bucket-access", async (c) => {
  const token = c.req.param("token");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const s = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const access = cleanAccess({ bucket: s("bucket"), accessKeyId: s("accessKeyId"), secret: s("secret") });
  const invalid = validateAccess(access);
  if (invalid) return c.json({ error: invalid }, 400);

  const r = await loadForEmail(c, token);
  if (!r) return c.json({ error: `Couldn't load ${token}.` }, 404);
  if (!(r.kind === "dataset" || sampleByBucket(r)) || r.status === "rejected") return c.json({ error: `${token} can't be given access.` }, 409);

  try {
    await emailBucketAccess({ token: r.token, kind: r.kind, email: r.email, name: r.full_name, hours: r.matching_hours, bytes: r.matching_bytes }, access);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[bucket-access]", token, reason);
    return c.json({ error: `The email didn't go out, so nothing changed: ${reason}` }, 502);
  }
  const { error } = await c.get("supabase").rpc("ots_record_access_sent", { p_token: token, p_bucket: access.bucket, p_access_key_id: access.accessKeyId });
  if (error) {
    console.error("[bucket-access] record", token, error.code, error.message);
    return c.json({ error: `The email reached ${r.email}, but it couldn't be recorded here: ${error.message}` }, 502);
  }
  return c.json({ ok: true });
});

// Every episode a dataset request matches, with where its files sit in R2: what an admin copies into
// the customer's bucket. Read-only, and it doesn't touch R2.
const PAGE = 1000;
const HEAD = [
  "environment", "skill", "difficulty", "task", "episode_id", "duration_s", "video_bytes", "mcap_bytes",
  "source_bucket", "video_keys", "mcap_key", "calibration_folders",
];
type Row = {
  episode_id: string; bucket: string; prefix: string; domain: string; skill: string;
  difficulty: string | null; task_name: string | null; duration_s: number; stereo_bytes: number | null; mcap_bytes: number | null;
};

adminRoutes.get("/requests/:token/files", async (c) => {
  const token = c.req.param("token");
  const supabase = c.get("supabase");
  const fail = (status: 403 | 404 | 503, message: string) => c.text(message, status);

  const admin = await supabase.rpc("is_ots_admin");
  if (admin.error || admin.data !== true) return fail(403, "Sign in as an OTS admin to download a file list.");

  const req = await supabase.from("ots_requests").select("capture_setup, environments, skills, difficulties, breakdown").eq("token", token).maybeSingle();
  if (req.error) return fail(503, `Couldn't load ${token}: ${req.error.message}`);
  if (!req.data) return fail(404, `No request ${token}.`);
  const r = req.data;
  // Skills are picked per environment, and the breakdown keeps which goes with which. Requests from
  // before 014 have none: their one list of skills applied to every environment.
  const pairs = r.breakdown ? new Set((r.breakdown as BreakdownEnvironment[]).flatMap((e) => e.skills.map((s) => `${e.domain}|${s.skill}`))) : null;

  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("ots_episodes")
      .select("episode_id, bucket, prefix, domain, skill, difficulty, task_name, duration_s, stereo_bytes, mcap_bytes")
      .eq("capture_setup", r.capture_setup)
      .in("domain", r.environments);
    // No pick means everything, the same rule as the kiosk's hours.
    if (!pairs && r.skills.length) q = q.in("skill", r.skills);
    if (r.difficulties.length) q = q.in("difficulty", r.difficulties);
    const page = await q.order("domain").order("skill").order("episode_id").range(from, from + PAGE - 1);
    // A partial list would quietly leave data out of the bucket, so all or nothing.
    if (page.error) return fail(503, `Couldn't load the episodes: ${page.error.message}`);
    rows.push(...(page.data as Row[]).filter((e) => !pairs || pairs.has(`${e.domain}|${e.skill}`)));
    if (page.data.length < PAGE) break;
  }

  const files = episodeFiles(r.capture_setup);
  const lines = rows.map((e) =>
    [
      domainName(e.domain), skillName(e.skill), e.difficulty ?? "not graded", e.task_name, e.episode_id, e.duration_s,
      e.stereo_bytes, e.mcap_bytes, e.bucket,
      files.videos.map((v) => e.prefix + v).join(" "),
      files.mcap ? e.prefix + files.mcap : "",
      files.calibration.map((x) => e.prefix + x).join(" "),
    ]
      .map(csvCell)
      .join(","),
  );
  return c.body([HEAD.join(","), ...lines].join("\n") + "\n", 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${token}-files.csv"`,
  });
});
