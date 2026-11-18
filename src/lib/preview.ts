import "server-only";
import { unstable_cache } from "next/cache";
import { api } from "./api";
import type { SetupId } from "./catalog";

// Preview clips are served by the OTS API (R2, its disk cache and the signing all live there).
// This server only asks how many clips each environment type has, and passes video requests
// through (src/app/api/preview/[slug]/route.ts).

export type ClipCounts = Record<SetupId, Record<string, number>>;

const EMPTY: ClipCounts = { ego: {}, head_wrist: {} };

const loadClips = unstable_cache(
  async () => {
    const res = await api("/v1/preview/clips", { timeoutMs: 10_000 });
    if (!res.ok) throw new Error(`OTS API answered ${res.status}`);
    const body = (await res.json()) as Partial<ClipCounts>;
    return { ego: body.ego ?? {}, head_wrist: body.head_wrist ?? {} } satisfies ClipCounts;
  },
  ["ots-preview-clips-api"],
  { revalidate: 300 },
);

/** How many clips each setup's environment types have. Counts only, never where they live. No previews if the API can't say. */
export async function previewClips(): Promise<ClipCounts> {
  try {
    return await loadClips();
  } catch (e) {
    console.warn("[preview] clip counts unavailable:", e instanceof Error ? e.message : e);
    return EMPTY;
  }
}
