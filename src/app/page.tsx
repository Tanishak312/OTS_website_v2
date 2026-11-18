import { Kiosk } from "@/components/kiosk/Kiosk";
import { InventoryProvider } from "@/components/kiosk/InventoryContext";
import { hoursBy } from "@/lib/inventory";
import { loadInventory } from "@/lib/inventory-server";
import { parseKioskUrl } from "@/lib/kiosk-url";
import { previewClips } from "@/lib/preview";
import { PreviewProvider } from "@/components/kiosk/Preview";

// Rendered on request, not at build time: the Docker build has no keys, so a page built
// then would carry the datasheet estimate. Supabase is still asked at most every 5
// minutes, see loadLive in inventory-server.ts.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const inventory = await loadInventory();
  // A shared link (?step=…&setup=…) opens on that step with those picks, rendered on the server so
  // the visitor never sees the landing page flash first. See src/lib/kiosk-url.ts for the format.
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const one of [v ?? []].flat()) query.append(k, one);
  const recorded = new Map<string, Record<string, number>>();
  const initial = parseKioskUrl(query, (setup, env) => {
    if (!recorded.has(setup)) recorded.set(setup, hoursBy(inventory, "domain", { setup }));
    return (recorded.get(setup)![env] ?? 0) > 0;
  });
  return (
    <InventoryProvider value={inventory}>
      {/* Only how many clips each environment type has crosses to the browser, never where the videos live. */}
      <PreviewProvider clips={await previewClips()}>
        <Kiosk initial={initial} />
      </PreviewProvider>
    </InventoryProvider>
  );
}
