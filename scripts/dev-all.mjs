// Runs the website and the backend together for local work: `npm run dev:all`.
// Each reads its own .env (./.env and ./backend/.env). Ctrl+C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apps = [
  { name: "backend ", cwd: join(root, "backend"), port: "5021" },
  { name: "frontend", cwd: root, port: "3010" },
];
const children = apps.map(({ name, cwd, port }) => {
  const child = spawn(process.execPath, [join(cwd, "scripts", "next.mjs"), "dev", port], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const out = (stream) => (buf) => buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => stream.write(`[${name}] ${l}\n`));
  child.stdout.on("data", out(process.stdout));
  child.stderr.on("data", out(process.stderr));
  child.on("exit", (code) => {
    console.log(`[${name}] exited (${code}); stopping the other`);
    stopAll();
  });
  return child;
});
function stopAll() {
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
