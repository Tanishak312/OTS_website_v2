import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config";
import { adminRoutes, authRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";

/**
 * The OTS API. Every route is under /v1, so a breaking change can ship as /v2 next to it while the
 * website and admin console move over. /health stays unversioned for load balancers.
 *
 *   public   GET  /v1/catalog  /v1/inventory  /v1/preview/clips  /v1/preview/:slug    POST /v1/requests
 *   auth     POST /v1/auth/login  /v1/auth/logout                  GET  /v1/auth/me
 *   admin    GET  /v1/admin/requests  /v1/admin/requests/:token  /v1/admin/requests/:token/files
 *            POST /v1/admin/requests/:token/status  .../resend-email  .../bucket-access
 */
export function createApp() {
  const app = new Hono();

  app.use(secureHeaders({ crossOriginResourcePolicy: false }));
  if (config.corsOrigins.length) {
    app.use("/v1/*", cors({ origin: config.corsOrigins, credentials: true, maxAge: 600 }));
  }
  // Request bodies are small JSON; nothing legitimate comes near this.
  app.use("/v1/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large." }, 413) }));

  app.get("/health", (c) => c.json({ ok: true }));

  const v1 = new Hono();
  v1.route("/", publicRoutes);
  v1.route("/auth", authRoutes);
  v1.route("/admin", adminRoutes);
  app.route("/v1", v1);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    console.error("[api] unhandled", c.req.method, c.req.path, err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Something went wrong on our side. Try again." }, 500);
  });
  return app;
}
