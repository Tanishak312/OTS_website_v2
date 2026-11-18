# OTS platform

The Awign off-the-shelf (OTS) robotics-data website and its backend, in one repo.

```
ots-platform/
├── .env                 website settings: PORT, OTS_API_URL. No secrets, ever.
├── src/  public/        the website (Next.js): kiosk steps, previews, request form, SEO
├── Dockerfile           website image
├── docker-compose.yml   website + backend on one machine
└── backend/
    ├── .env             EVERY credential (Supabase, Resend, R2) lives here and only here
    ├── src/api/         the API, served at /v1/*
    ├── src/app/admin/   the admin portal, served at /admin
    ├── supabase/        database migrations (run by hand in the Supabase SQL editor)
    ├── scripts/         encode_previews.py (re-encode preview clips for the web)
    └── Dockerfile       backend image
```

```
browser ──▶ website ──(server to server, OTS_API_URL)──▶ backend /v1 ──▶ Supabase · R2 · Resend
admin   ──▶ backend /admin ─────────────────────────────────────────────▶ Supabase · Resend
```

**The rule:** the website never talks to the database, R2 or email itself and holds no keys. It
asks the backend. Anyone given the website code (e.g. to embed it in another site) gets nothing
secret.

## Run locally

```bash
npm run setup                          # installs the website and the backend
cp .env.example .env                   # PORT=3010, OTS_API_URL=http://127.0.0.1:5021
cp backend/.env.example backend/.env   # then fill in the keys
npm run dev:all                        # both together: website :3010, backend :5021
```

Or one at a time: `npm run dev` (website), `npm run dev:backend` (backend).

| | Website | Backend |
|---|---|---|
| Open | http://localhost:3010 | http://localhost:5021/admin |
| Port setting | `PORT` in `./.env` | `PORT` in `./backend/.env` |
| Dev / build / start | `npm run dev` / `build` / `start` | `npm run dev:backend` / `build:backend` / `start:backend` |
| Typecheck | `npm run typecheck` | `npm run typecheck:backend` |

`.env` and `backend/.env` are git-ignored. Only the `.env.example` files are committed, so they
must hold names and harmless defaults, never real keys.

## Backend API

All under `/v1`; a breaking change ships as `/v2` alongside so the website never breaks mid-deploy.
Errors are always `{ "error": "<message written for people>" }`.

| Method | Path | What |
|---|---|---|
| GET | `/health` | `{ ok: true }` for load balancers |
| GET | `/v1/catalog` | Setups, environment types, skills, levels, specs, FAQs |
| GET | `/v1/inventory` | Hours / episodes / sizes per setup·environment·skill·level (cached 5 min) |
| GET | `/v1/preview/clips` | How many preview clips each environment type has |
| GET, HEAD | `/v1/preview/:slug?setup=ego\|head_wrist&clip=n` | One preview clip, streamed, Range supported |
| POST | `/v1/requests` | Submit a dataset / sample request → `201 { token }` |
| POST | `/v1/auth/login`, `/v1/auth/logout` · GET `/v1/auth/me` | Admin session (httpOnly cookies) |
| GET | `/v1/admin/requests`, `/v1/admin/requests/:token`, `.../files` | Admin data |
| POST | `/v1/admin/requests/:token/status`, `.../resend-email`, `.../bucket-access` | Admin actions |

The admin portal's own pages call the same code directly (no network hop), with the same checks:
what an admin may read and change is enforced in Postgres (row-level security and the `set_ots_*`
functions). Only the Supabase anon key is used, never the service role.

## Speed

- The website keeps the inventory and clip counts it gets from the backend for 5 minutes; the
  backend keeps its own 5-minute copy of Supabase's answer. Almost no page render waits on a call.
- Preview clips: the backend copies each clip to its disk after the first view and serves it from
  there; the website streams it through untouched (Range requests included).
- Keep the website and backend in the same region: the call between them is then a few ms.

## Scaling

Both apps keep nothing a user depends on between requests, so each can run as many copies as
needed behind a load balancer. Per-copy pieces to move out when there are many copies:

| Kept per copy today | At scale |
|---|---|
| Inventory memory cache, request-form rate limit | Redis |
| Preview clip disk cache | A CDN in front of the preview bucket |
| Customer email sent during the request | A job queue |

## Deploy (Docker)

```bash
cp .env.example .env && cp backend/.env.example backend/.env   # fill backend/.env
docker compose up -d --build
```

Website on port 5011, backend on 5021 (`network_mode: host`, Linux). Open 5011 to the world; open
5021 only to the admin team or put it behind its own load balancer. Images are built without keys;
settings are read when the containers start.
