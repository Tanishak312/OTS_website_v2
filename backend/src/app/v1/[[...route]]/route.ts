import { handle } from "hono/vercel";
import { createApp } from "@/api/app";

// The whole OTS API (src/api/app.ts) answers every /v1/* request: the website and anything else
// that needs data call these. Runs on Node (streams, disk cache), never cached by Next.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = handle(createApp());

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const OPTIONS = handler;
