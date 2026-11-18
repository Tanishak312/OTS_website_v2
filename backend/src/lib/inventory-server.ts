import { config } from "@/api/config";
import { estimateInventory, parseInventory, type Inventory } from "./inventory";
import { kioskClient } from "./supabase";

/** Full datasets include MCAP, so their sizes count it. Set on the server. */
const mcapOffered = () => process.env.OFFER_MCAP?.trim() === "true";

// Kept in memory for INVENTORY_TTL_S (5 min): the index only changes when a new sheet is imported,
// and no page should wait on Supabase for every visitor. Visitors arriving together share one
// Supabase call. Used by the API (/v1/inventory, request checks) and the admin portal alike.
// Each server copy keeps its own; with many copies this moves to Redis.
let live: { at: number; inv: Inventory } | null = null;
let loading: Promise<Inventory> | null = null;

async function loadLive(): Promise<Inventory> {
  if (live && Date.now() - live.at < config.inventoryTtlMs) return live.inv;
  loading ??= (async () => {
    try {
      const { data, error } = await kioskClient().rpc("ots_inventory");
      // Throw so a failure isn't cached; the caller falls back for this request only.
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      const inv = parseInventory(data);
      live = { at: Date.now(), inv };
      return inv;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Live catalogue numbers, or the datasheet estimate (logged) if Supabase can't serve them. */
export async function loadInventory(): Promise<Inventory> {
  try {
    return { ...(await loadLive()), mcap: mcapOffered() };
  } catch (e) {
    const code = (e as { code?: string }).code;
    const hint = code === "PGRST202" ? " -> run supabase/005_inventory.sql" : "";
    // A stale copy beats the estimate: serve the last good one if there is one.
    if (live) {
      console.warn(`[inventory] Supabase failed, serving the last good copy${hint}:`, e instanceof Error ? e.message : e);
      return { ...live.inv, mcap: mcapOffered() };
    }
    console.warn(`[inventory] falling back to datasheet estimate${hint}:`, e instanceof Error ? e.message : e);
    return { ...estimateInventory(), mcap: mcapOffered() };
  }
}
