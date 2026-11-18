import "server-only";
import { unstable_cache } from "next/cache";
import { api } from "./api";
import { estimateInventory, parseInventory, type Inventory } from "./inventory";

// Kept here for 5 minutes as before (the API keeps its own 5-minute copy too), so a page render
// almost never waits on a network call.
const loadLive = unstable_cache(
  async () => {
    const res = await api("/v1/inventory", { timeoutMs: 10_000 });
    // Throw so a failure isn't cached; the caller falls back for this request only.
    if (!res.ok) throw new Error(`OTS API answered ${res.status}`);
    const body = (await res.json()) as Partial<Inventory>;
    // The API says itself when it is serving the estimate (Supabase down); keep that, and whether MCAP ships.
    return { ...parseInventory(body), source: body.source === "estimate" ? "estimate" : "live", mcap: body.mcap === true } satisfies Inventory;
  },
  ["ots-inventory-api"],
  { revalidate: 300 },
);

/** Live catalogue numbers from the API, or the datasheet estimate (logged) if it can't be reached. */
export async function loadInventory(): Promise<Inventory> {
  try {
    return await loadLive();
  } catch (e) {
    // A warning, not an error: the kiosk still works, just on estimates.
    console.warn("[inventory] falling back to datasheet estimate:", e instanceof Error ? e.message : e);
    return estimateInventory();
  }
}
