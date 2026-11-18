# Integrating the OTS website (frontend)

For the team embedding the OTS website into another codebase. It covers everything the frontend
talks to, so the flow keeps working after the move.

## The one rule

The frontend talks to **one thing only: the OTS backend**, at the address in `OTS_API_URL`.
It never talks to Supabase, Cloudflare R2 or Resend, and holds no keys. Those live in
`backend/`, which the OTS team runs and deploys separately.

```
visitor's browser ──▶ frontend (Next.js) ──server to server──▶ OTS backend ──▶ Supabase · R2 · Resend
                       routes listed in §2                       4 endpoints in §3
```

**The browser never calls the backend directly.** Every backend call is made by the frontend's
server: page renders, the preview-video route and the form's server action. That is why no CORS,
API key or token is needed on the frontend side.

## 1. Settings

| Variable | Where | Value |
|---|---|---|
| `OTS_API_URL` | frontend server only | The backend's address as the frontend **server** reaches it, e.g. `http://10.0.1.23:5021` or an internal load balancer. **Never** prefix it `NEXT_PUBLIC_` (it would ship to browsers). No trailing slash needed. |
| `OTS_INTERNAL_KEY` | frontend server only | Shared secret, the same value as the backend's. The backend accepts the request form only from a caller that sends it (§3.4). Ask the OTS team for it; never prefix it `NEXT_PUBLIC_`, never log it. |
| `PORT` | frontend server | Port to listen on (only with `npm run dev` / `npm start` from this repo). |

Run the frontend and backend **in the same region**: page renders call the backend, and a
same-region call is a few ms.

Requirements: Node 20+, Next.js 15 (App Router), React 19, Tailwind CSS 4.

## 2. Routes the frontend serves to browsers

Keep these working, at these paths, wherever the frontend ends up.

| Route | What it is | What it calls on the backend |
|---|---|---|
| `GET /` | The kiosk page, rendered on the server | `GET /v1/inventory`, `GET /v1/preview/clips` (§3.1, §3.2) |
| `GET /?step=…&setup=…&env=…&skills=…&level=…&preview=…` | Same page opened at a step (shareable links; format in `src/lib/kiosk-url.ts`) | same as above |
| `GET`, `HEAD /api/preview/:slug?setup=&clip=` | Preview video, streamed through | `GET`/`HEAD /v1/preview/:slug` (§3.3) |
| `POST /` (Next.js server action `submitRequest`, `src/app/actions.ts`) | The request form's submit | `POST /v1/requests` (§3.4) |
| `GET /api/health` | `{ ok: true }` for load balancers | nothing |
| `/images/*`, `/domains/*` | Static images in `public/` | nothing |

`/v2` permanently redirects to `/` (old links).

## 3. Backend endpoints the frontend calls

These four, and no others. All JSON errors look like `{ "error": "message written for people" }`;
the frontend shows that message as is.

### 3.1 `GET /v1/inventory`

Hours, episodes and sizes for every setup × environment × skill × difficulty. Every number on
the page is a sum over these rows.

```jsonc
{
  "cells": [
    // [setup, environment, skill, difficulty, episodes, seconds, video bytes, MCAP bytes]
    ["ego", "industrial-manufacturing", "tool-use", "hard", 50, 19442, 3108819000, 0]
  ],
  "tasks": 4017,          // distinct tasks, or null when estimated
  "source": "live",       // "estimate" if the backend couldn't reach the database
  "mcap": true            // whether full datasets ship MCAP
}
```

- Caller: page render (`src/lib/inventory-server.ts`). Cached on the frontend for **5 minutes**
  (the backend also caches it 5 minutes), so a render almost never waits on it.
- Timeout 10 s. If the backend can't be reached, the page falls back to built-in estimates and
  still works.

### 3.2 `GET /v1/preview/clips`

How many preview clips each environment has, per capture setup. Never file names or locations.

```json
{ "ego": { "industrial-manufacturing": 3, "food-beverage": 3 }, "head_wrist": { "home": 2 } }
```

- Caller: page render (`src/lib/preview.ts`). Cached **5 minutes**. Timeout 10 s.
- If unreachable: no previews are shown; everything else works.

### 3.3 `GET` / `HEAD /v1/preview/:slug?setup=ego|head_wrist&clip=N`

One preview clip (H.264 MP4). `setup` defaults to `ego`, `clip` to `1`.

- Caller: `src/app/api/preview/[slug]/route.ts`, which **streams the response through untouched**.
- Forward the browser's `Range`, `If-None-Match` and `If-Modified-Since` headers; pass back the
  status and `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`,
  `Last-Modified`, `Cache-Control`, `Content-Disposition`. Video seeking depends on this.
- Statuses: `200` whole file, `206` a range, `416` range past the end, `404` unknown slug/setup/clip.
- Do **not** buffer the body or put a total-time limit on it: a clip is 10–30 MB and streams for as
  long as the visitor watches. Only the wait for the first response is limited (15 s → `502`).

### 3.4 `POST /v1/requests`

The form's submit: a full-dataset or free-sample request.

```jsonc
// request body
{
  "kind": "dataset",                                     // or "sample"
  "setup": "ego",                                        // or "head_wrist"
  "environments": ["industrial-manufacturing", "food-beverage"],
  "skills": { "food-beverage": ["tool-use", "assembly"] }, // per environment; missing = all its skills, [] = none
  "difficulties": ["hard"],                              // [] = all levels
  "fullName": "Asha Rao",
  "email": "asha@company.com",
  "company": "Company",
  "phone": "",                                           // optional
  "forTraining": true                                    // the Yes/No question, required
}
```

| Status | Body | Meaning |
|---|---|---|
| `201` | `{ "token": "OTS-…" }` | Saved; the customer email has been sent (or the failure is recorded for the admins) |
| `400` | `{ error }` | Body unreadable |
| `403` | `{ error }` | `X-OTS-Internal-Key` missing or wrong |
| `413` | `{ error }` | Body over 64 KB |
| `422` | `{ error }` | A choice or a contact field is invalid (message says which) |
| `429` | `{ error }` | More than 10 submissions from this visitor in 10 minutes |
| `502` / `503` | `{ error }` | Couldn't save just now; the visitor can retry |

- Caller: the server action `submitRequest` (`src/app/actions.ts`). Timeout 30 s (it saves, then
  sends an email before answering). The form keeps what was typed on any error.
- **Send two headers**, as `visitorHeaders()` in `src/lib/api.ts` does:
  - `X-OTS-Internal-Key: <OTS_INTERNAL_KEY>`: without it the backend answers `403`. This is what
    stops anyone from calling the backend directly to send requests (and emails) or to dodge the
    limit.
  - `X-OTS-Client-IP: <visitor's IP>`: the 10-per-10-minutes limit is per visitor; without it
    every visitor looks like the frontend server and ten submissions site-wide lock everyone out.
    Take the right-most **public** address in the incoming `X-Forwarded-For` (the one your load
    balancer added; entries to its left come from the visitor and can be faked). So the frontend
    must sit behind a load balancer or reverse proxy that appends to `X-Forwarded-For`.
- Never retry automatically and never cache it: each call can create a request and send an email.
- The backend recomputes the hours itself; the frontend's numbers are for display only.

### Not used by the frontend today

`GET /v1/catalog` returns the same environment / skill / setup lists the frontend ships in
`src/lib/catalog.ts`. The admin endpoints (`/v1/auth/*`, `/v1/admin/*`) are for the OTS admin
portal only.

## 4. Two ways to integrate

**A. Run it as its own app (recommended).** Deploy this frontend as a separate Node service and
route a path of your site to it from your reverse proxy / load balancer. Nothing in your codebase
changes, and updates ship independently. Today the app expects to be served **at the root of its
host** (it uses `/api/preview/...`, `/images/...`): either give it a host of its own, or tell the
OTS team the sub-path so they can add a `basePath` before you route to it.

**B. Merge the code into your Next.js app.** Copy:

- `src/components/` (kiosk UI), `src/lib/` (catalog, selection maths, URL state, API client),
  `src/app/actions.ts`, `src/app/api/preview/[slug]/route.ts`, the page in `src/app/page.tsx`
- `public/images/`, `public/domains/`
- the kiosk styles in `src/app/globals.css` (Tailwind 4; tokens and animations are at the top)
  and the two fonts set up in `src/app/layout.tsx` (Inter, JetBrains Mono)

Keep the `server-only` imports: they stop `src/lib/api.ts` from ever being bundled for browsers.

## 5. Check after integrating

- [ ] The page opens with real hours (not "estimate"), and preview cards show videos.
- [ ] A shared link (`/?step=tasks&setup=ego&env=industrial-manufacturing`) opens on step 3.
- [ ] Seeking inside a preview video works (Range requests reach the backend: `206` responses).
- [ ] Submitting the form with an empty field shows the field's message; nothing is sent.
- [ ] A real submit shows the success screen with a token (coordinate with the OTS team first: it
      creates a real request and sends a real email).
- [ ] `OTS_API_URL` is not visible in any browser bundle or page source.
