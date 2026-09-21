import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas ships a native .node binary — Turbopack can't bundle it
  // into an ESM chunk, so it needs to stay a plain runtime require() instead.
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default nextConfig;
