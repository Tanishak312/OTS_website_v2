import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The Docker image runs .next/standalone/server.js.
  output: "standalone",
  // This folder is its own app (the repo holds two, each with its own lockfile): trace and lay out
  // the standalone build from here, so .next/standalone/server.js sits at the top as Docker expects.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
