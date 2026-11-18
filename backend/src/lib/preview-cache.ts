import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Preview clips kept on this server's own disk, so after the first viewer a clip is served from
// here instead of a round trip to R2 for every range the browser asks for (a video asks for
// several). Only ever written by this server, from the preview bucket, through the same read-only
// token; nothing here writes to R2. Lost on a redeploy, and that's fine: it refills on use.
//
//   PREVIEW_CACHE_DIR      where the files go (default: <os tmp>/ots-preview-cache)
//   PREVIEW_CACHE_MAX_MB   how much disk it may use (default 3072); 0 turns the cache off
//
// A file is named after the object's key and ETag, so a clip replaced in the bucket under the same
// name is fetched fresh, never served stale. Oldest-used files go first when the cap is reached.

export type ObjectMeta = { etag: string; size: number };

// Built at run time on purpose: `next build` traces file paths it can work out, and a plain
// join(tmpdir(), "...") made it try to copy this cache (gigabytes of clips, if any are there) into
// the build output.
const DIR = process.env.PREVIEW_CACHE_DIR?.trim() || [tmpdir(), "ots-preview-cache"].join(sep);
const MAX_BYTES = (() => {
  const mb = Number(process.env.PREVIEW_CACHE_MAX_MB ?? 3072);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0;
})();
/** Downloads running at once: enough to fill a page of cards, not so many that a cold start floods R2. */
const MAX_FILLS = 2;

const fileFor = (key: string, meta: ObjectMeta) =>
  join(DIR, createHash("sha256").update(`${key}\n${meta.etag}\n${meta.size}`).digest("hex").slice(0, 32) + ".mp4");

/** The cached copy of this object, or null. A file of the wrong size (a half-written leftover) doesn't count. */
export async function cached(key: string, meta: ObjectMeta | undefined): Promise<string | null> {
  if (!MAX_BYTES || !meta) return null;
  const file = fileFor(key, meta);
  try {
    if ((await stat(file)).size !== meta.size) return null;
    const now = new Date();
    utimes(file, now, now).catch(() => {}); // last used, for the eviction order
    return file;
  } catch {
    return null;
  }
}

const filling = new Set<string>();
const queue: (() => Promise<void>)[] = [];
let running = 0;

function pump() {
  while (running < MAX_FILLS && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

/**
 * Copy the whole object to disk in the background, if it isn't there or on its way already.
 * `download` returns R2's full (200) response for the object. Never throws: a failed copy just
 * means the next request goes to R2 again.
 */
export function fill(key: string, meta: ObjectMeta | undefined, download: () => Promise<Response>) {
  if (!MAX_BYTES || !meta || meta.size <= 0 || meta.size > MAX_BYTES / 4) return;
  const file = fileFor(key, meta);
  if (filling.has(file)) return;
  filling.add(file);
  queue.push(async () => {
    const part = `${file}.${process.pid}.part`;
    try {
      if (await cached(key, meta)) return;
      await mkdir(DIR, { recursive: true });
      const res = await download();
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel();
        throw new Error(`r2 answered ${res.status}`);
      }
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part));
      if ((await stat(part)).size !== meta.size) throw new Error("size does not match the listing");
      await rename(part, file);
      await evict();
    } catch (e) {
      console.error("[preview] cache fill failed:", e instanceof Error ? e.message : "error");
      await unlink(part).catch(() => {});
    } finally {
      filling.delete(file);
    }
  });
  pump();
}

/** Drop the least recently used files until the cache is under its cap. */
async function evict() {
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of await readdir(DIR)) {
    if (!name.endsWith(".mp4")) continue;
    const path = join(DIR, name);
    const s = await stat(path).catch(() => null);
    if (s) files.push({ path, size: s.size, mtimeMs: s.mtimeMs });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // a file still being streamed survives its unlink on Linux
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files) {
    if (total <= MAX_BYTES) break;
    await unlink(f.path).catch(() => {});
    total -= f.size;
  }
}

// One range, as browsers send for video: "bytes=0-", "bytes=1000-1999", "bytes=-500".
const RANGE_RE = /^bytes=(\d{0,15})-(\d{0,15})$/;

/**
 * Serve a cached file the way R2 would: 200 for the whole file, 206 for one range, 416 for a range
 * past the end. `headers` already carries the content type and the rest.
 */
export function serveFile(file: string, size: number, range: string | null, headers: Headers, method: "GET" | "HEAD"): Response {
  headers.set("accept-ranges", "bytes");
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = range ? RANGE_RE.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(m[2])); // the last n bytes
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    status = 206;
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (method === "HEAD") return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}
