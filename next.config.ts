import type { NextConfig } from "next";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ''

const nextConfig: NextConfig = {
  // Phase 3: fully static client-rendered app. `next build` emits out/ with
  // one HTML per route; no Node runtime, no Server Actions, no dynamic routes.
  output: 'export',
  allowedDevOrigins: ['127.0.0.1'],
  // Phase 20: subpath deploy for GitHub Pages. Empty string = no-op (private/native builds).
  ...(BASE_PATH ? { basePath: BASE_PATH, assetPrefix: BASE_PATH } : {}),
};

export default nextConfig;
