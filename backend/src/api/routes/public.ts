import { Hono } from "hono";
import { config } from "@/api/config";
import { loadInventory } from "@/lib/inventory-server";
import {
  DATA_PACKAGE,
  DATASET,
  DEVICES,
  DIFFICULTIES,
  DOMAINS,
  FAQS,
  HARDWARE_SPECS,
  MCAP_CONTENTS,
  SETUPS,
  SKILLS,
} from "@/lib/catalog";
import { emailCustomer } from "@/lib/delivery";
import { parseClip, parseSetup, previewClips, previewResponse } from "@/lib/preview";
import {
  activeEnvironments,
  matchingBytes,
  matchingHours,
  pickedSkills,
  requestBreakdown,
  validatePayload,
  type RequestPayload,
} from "@/lib/selection";
import { isInternal } from "@/api/client-ip";
import { allow, clientIp } from "@/api/rate-limit";
import { kioskClient } from "@/api/supabase";

export const publicRoutes = new Hono();

// What the site shows that only changes with a deploy or a new sheet import. Shared caches
// (a CDN, the website's own server) may keep it; browsers keep it a minute.
const CACHE_5MIN = { "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" };

/** The fixed catalogue: setups, environment types, skills, levels, specs, FAQs. Names and copy, no numbers that change. */
publicRoutes.get("/catalog", (c) =>
  c.json(
    {
      dataset: DATASET,
      setups: SETUPS,
      domains: DOMAINS,
      skills: SKILLS,
      difficulties: DIFFICULTIES,
      hardwareSpecs: HARDWARE_SPECS,
      dataPackage: DATA_PACKAGE,
      devices: DEVICES,
      mcapContents: MCAP_CONTENTS,
      faqs: FAQS,
    },
    200,
    CACHE_5MIN,
  ),
);

/** Hours, episodes and sizes per setup / environment / skill / level, from the episode index (cached 5 min). */
publicRoutes.get("/inventory", async (c) => c.json(await loadInventory(), 200, CACHE_5MIN));

/** How many preview clips each setup's environment types have. Counts only, never where they live. */
publicRoutes.get("/preview/clips", async (c) => c.json(await previewClips(), 200, CACHE_5MIN));

/** One preview clip, streamed with Range support: /preview/<slug>?setup=ego|head_wrist&clip=<n>. */
publicRoutes.on(["GET", "HEAD"], "/preview/:slug", (c) =>
  previewResponse(
    c.req.param("slug"),
    parseSetup(c.req.query("setup") ?? null),
    parseClip(c.req.query("clip") ?? null),
    c.req.header("range") ?? null,
    c.req.method === "HEAD" ? "HEAD" : "GET",
  ),
);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Only the fields a request has, each with the right type, so a malformed body gets the same
 * readable message as a wrong pick instead of crashing a check halfway.
 */
function toPayload(body: unknown): RequestPayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const skills: Record<string, string[]> = {};
  if (b.skills && typeof b.skills === "object" && !Array.isArray(b.skills)) {
    for (const [env, list] of Object.entries(b.skills as Record<string, unknown>)) skills[env] = strList(list);
  }
  return {
    kind: str(b.kind) as RequestPayload["kind"],
    setup: (str(b.setup) || null) as RequestPayload["setup"],
    environments: strList(b.environments),
    skills,
    difficulties: strList(b.difficulties) as RequestPayload["difficulties"],
    fullName: str(b.fullName),
    email: str(b.email),
    phone: str(b.phone),
    company: str(b.company),
    forTraining: typeof b.forTraining === "boolean" ? b.forTraining : null,
  };
}

/**
 * A dataset or sample request from the kiosk. 201 { token } when saved; 4xx/5xx { error } with a
 * message written for the visitor. The customer email goes out after the save; a failed email
 * doesn't fail the request (it shows on the admin page).
 */
let warnedNoKey = false;

publicRoutes.post("/requests", async (c) => {
  // Only the OTS website's server may submit: it holds OTS_INTERNAL_KEY. A script calling this API
  // directly can't send requests (and emails to any address it likes), or dodge the per-visitor limit.
  if (config.internalKey) {
    if (!isInternal(c)) return c.json({ error: "Requests are accepted from the OTS website only." }, 403);
  } else if (process.env.NODE_ENV === "production") {
    console.error("[requests] OTS_INTERNAL_KEY is not set: refusing submissions (set the same value on the website and the backend)");
    return c.json({ error: "The request system isn't set up yet. Please tell the booth team." }, 503);
  } else if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn("[requests] OTS_INTERNAL_KEY is not set: accepting submissions from anyone (development only)");
  }
  if (!allow("submit", clientIp(c), config.submitLimit, config.submitWindowMs)) {
    return c.json({ error: "Too many requests from here. Wait a few minutes, then try again." }, 429);
  }
  const payload = toPayload(await c.req.json().catch(() => null));
  if (!payload) return c.json({ error: "The request couldn't be read. Reload the page and try again." }, 400);
  const invalid = validatePayload(payload);
  if (invalid) return c.json({ error: invalid }, 422);

  let client;
  try {
    client = kioskClient();
  } catch (e) {
    console.error("[requests] config", e instanceof Error ? e.message : e);
    return c.json({ error: "The kiosk is not connected to the request system. Please tell the booth team." }, 503);
  }

  // Hours are recomputed here from the episode index rather than trusted from the browser.
  const inventory = await loadInventory();
  const hours = matchingHours(payload, inventory);
  if (hours <= 0) {
    return c.json({ error: "No recordings match these choices yet. Go back and widen your environment types or skills." }, 422);
  }
  const wholeHours = Math.max(1, Math.round(hours)); // the column is whole hours
  // Kept on a full-dataset request: what the admin fills the bucket against. A sample is the same for everyone.
  const dataset = payload.kind === "dataset";
  const bytes = dataset ? Math.round(matchingBytes(payload, inventory)) : null;

  const { data, error } = await client.rpc("submit_ots_request", {
    p_kind: payload.kind,
    p_setup: payload.setup,
    p_environments: activeEnvironments(payload),
    // The column holds every skill named; which environment each belongs to is in the breakdown.
    p_skills: pickedSkills(payload),
    p_difficulties: payload.difficulties,
    p_matching_hours: wholeHours,
    p_full_name: payload.fullName.trim(),
    p_email: payload.email.trim(),
    p_phone: payload.phone.trim() || null,
    p_company: payload.company.trim() || null,
    p_source: "kiosk",
    p_matching_bytes: bytes,
    p_breakdown: dataset ? requestBreakdown(payload, inventory) : null,
    p_for_training: payload.forTraining === true,
  });

  if (error || typeof data !== "string") {
    // Log the code and message only: the error never carries the arguments, but keep it that way.
    console.error("[requests] rpc", error?.code, error?.message);
    return c.json({ error: "We couldn't send your request just now. Your details are still here, so please try again." }, 502);
  }
  // The request is saved whatever happens here; a failed email shows on its admin page.
  await emailCustomer(client, {
    token: data,
    kind: payload.kind,
    email: payload.email.trim(),
    name: payload.fullName.trim(),
    setup: payload.setup as string,
    hours: wholeHours,
    bytes,
  });
  return c.json({ token: data }, 201);
});
