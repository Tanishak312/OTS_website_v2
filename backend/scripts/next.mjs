// Runs `next dev` / `next start` on the PORT set in this folder's .env.
// (Next can't take PORT from .env itself: its server is listening before it reads .env.)
//   node scripts/next.mjs dev 3010      -> PORT from .env, else 3010
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const [, , cmd = "dev", fallback = "3000", ...rest] = process.argv;
try {
  process.loadEnvFile(".env");
} catch {
  // No .env: use the fallback port.
}
const port = process.env.PORT?.trim() || fallback;
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, cmd, "-p", port, ...rest], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
