import { proxy } from "@/lib/api";

// One clip of one environment type's preview: /api/preview/<slug>?setup=<setup>&clip=<n>.
// Streamed straight through from the OTS API (Range requests included), which checks the
// arguments and holds the R2 access. Kept at this address so the browser stays same-origin.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

function target(request: Request, slug: string) {
  const q = new URL(request.url).searchParams;
  const out = new URLSearchParams();
  for (const k of ["setup", "clip"]) {
    const v = q.get(k);
    if (v !== null) out.set(k, v);
  }
  const qs = out.toString();
  return `/v1/preview/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`;
}

export async function GET(request: Request, { params }: Ctx) {
  return proxy(request, target(request, (await params).slug));
}

export async function HEAD(request: Request, { params }: Ctx) {
  return proxy(request, target(request, (await params).slug));
}
