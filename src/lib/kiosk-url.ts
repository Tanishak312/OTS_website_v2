import { DIFFICULTY_BY_ID, DOMAIN_BY_SLUG, SETUP_BY_ID, SKILL_BY_SLUG, type DifficultyId, type SetupId } from "./catalog";
import { EMPTY_SELECTION, type Selection, type SkillPicks } from "./selection";

/**
 * The kiosk's place in the URL, so a link opens the same step with the same picks:
 *
 *   /?step=tasks&setup=ego&env=industrial-manufacturing,food-beverage
 *     &skills=food-beverage:tool-use,assembly&level=hard,medium&preview=food-beverage
 *
 *   step     setup | environments | tasks | review | details | sample-details   (none = landing)
 *   setup    ego | head_wrist
 *   env      environment slugs, in the order picked
 *   skills   one per narrowed environment, "<env>:<skill>,<skill>"; "<env>:" = none kept.
 *            An environment with no skills entry keeps all of its skills.
 *   level    difficulty ids
 *   preview  the environment shown in the preview card
 *
 * Contact details and request tokens never go in the URL: a link is shared, and the kiosk is too.
 * Anything unknown is dropped, and a step whose earlier picks are missing falls back to the
 * furthest step those picks allow, so a hand-edited or stale link still opens something sensible.
 */

export type Screen =
  | "landing"
  | "setup"
  | "environments"
  | "tasks"
  | "review"
  | "contact-dataset"
  | "contact-sample"
  | "done-dataset"
  | "done-sample";

const STEP_PARAM: Partial<Record<Screen, string>> = {
  setup: "setup",
  environments: "environments",
  tasks: "tasks",
  review: "review",
  "contact-dataset": "details",
  "contact-sample": "sample-details",
};
const SCREEN_OF_STEP = Object.fromEntries(Object.entries(STEP_PARAM).map(([s, p]) => [p, s as Screen])) as Record<string, Screen>;

/** The screen Back leads to, and the trail a deep link starts with so in-app Back walks the steps. */
const PARENT: Partial<Record<Screen, Screen>> = {
  setup: "landing",
  environments: "setup",
  tasks: "environments",
  review: "tasks",
  "contact-dataset": "review",
  "contact-sample": "review",
};

export function trailTo(screen: Screen): Screen[] {
  const trail: Screen[] = [screen];
  for (let s = PARENT[screen]; s; s = PARENT[s]) trail.unshift(s);
  return trail;
}

/** The furthest screen at or before `screen` that this selection can show. */
export function clampScreen(screen: Screen, sel: Selection): Screen {
  const needs = (s: Screen): boolean => {
    if (s === "landing" || s === "setup") return true;
    if (!sel.setup) return false;
    if (s === "environments") return true;
    return sel.environments.length > 0; // tasks, review, details
  };
  let s: Screen | undefined = screen;
  while (s && !needs(s)) s = PARENT[s];
  return s ?? "landing";
}

export type KioskUrlState = { screen: Screen; sel: Selection; preview: string | null };

type Params = { get(name: string): string | null; getAll(name: string): string[] };

const list = (v: string | null) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const unique = <T,>(xs: T[]) => [...new Set(xs)];

/**
 * Read the kiosk state from a query string. `recorded(setup, env)` says whether an environment
 * has footage for that setup; environments without any are dropped (they'd match nothing).
 */
export function parseKioskUrl(params: Params, recorded?: (setup: SetupId, env: string) => boolean): KioskUrlState {
  const setupRaw = params.get("setup");
  const setup = setupRaw && setupRaw in SETUP_BY_ID ? (setupRaw as SetupId) : null;

  let environments = unique(list(params.get("env")).filter((e) => e in DOMAIN_BY_SLUG));
  if (setup && recorded) environments = environments.filter((e) => recorded(setup, e));

  const skills: SkillPicks = {};
  for (const entry of params.getAll("skills")) {
    const at = entry.indexOf(":");
    if (at < 0) continue;
    const env = entry.slice(0, at);
    if (!environments.includes(env)) continue;
    skills[env] = unique(list(entry.slice(at + 1)).filter((s) => s in SKILL_BY_SLUG));
  }

  const difficulties = unique(list(params.get("level")).filter((d) => d in DIFFICULTY_BY_ID)) as DifficultyId[];

  const sel: Selection = setup
    ? { setup, environments, skills, difficulties }
    : // No setup: nothing after it means anything yet. Keep the kiosk's usual starting state.
      { ...EMPTY_SELECTION };

  const stepRaw = params.get("step");
  const wanted = stepRaw ? SCREEN_OF_STEP[stepRaw] : undefined;
  const screen = wanted ? clampScreen(wanted, sel) : "landing";

  const previewRaw = params.get("preview");
  const preview = previewRaw && environments.includes(previewRaw) ? previewRaw : null;

  return { screen, sel, preview };
}

// Slugs are [a-z0-9_-], so only "," and ":" need to stay readable; everything else is escaped.
const enc = (v: string) => encodeURIComponent(v).replace(/%2C/gi, ",").replace(/%3A/gi, ":");

/** The query string ("?…", or "" for the landing page) for this kiosk state. */
export function kioskSearch({ screen, sel, preview }: KioskUrlState): string {
  const step = STEP_PARAM[screen];
  // The landing page and the thank-you screens are plain "/": a finished request isn't something to re-open.
  if (!step) return "";
  const parts: [string, string][] = [["step", step]];
  if (sel.setup) {
    parts.push(["setup", sel.setup]);
    if (sel.environments.length) parts.push(["env", sel.environments.join(",")]);
    for (const env of sel.environments) {
      const kept = sel.skills[env];
      if (kept) parts.push(["skills", `${env}:${kept.join(",")}`]);
    }
    if (sel.difficulties.length) parts.push(["level", sel.difficulties.join(",")]);
    if (preview && sel.environments.includes(preview)) parts.push(["preview", preview]);
  }
  return "?" + parts.map(([k, v]) => `${k}=${enc(v)}`).join("&");
}
