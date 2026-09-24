import type { NextConfig } from "next";

/*
 * Stamps every asset URL so a request from a tab running an older build is
 * recognisable as skew rather than as a plain 404.
 *
 * Read at BUILD time only, which is correct rather than a shortcut: Next
 * serialises it into .next/required-server-files.json and the standalone server
 * reads the value from there, so build and runtime cannot disagree.
 *
 * The Dockerfile computes BUILD_ID, preferring Coolify's SOURCE_COMMIT and
 * falling back to a timestamp. Deliberately NOT read from SOURCE_COMMIT here:
 * Coolify exposes that to the RUNNING container and does not pass it as a build
 * arg, so wiring it that way stamps nothing while still looking correct.
 *
 * Left undefined rather than empty when absent (a local `next build`): an empty
 * deploymentId still appends a bare `?dpl=` to every asset URL.
 */
const deploymentId = process.env.BUILD_ID?.trim() || undefined;

const nextConfig: NextConfig = {
  ...(deploymentId ? { deploymentId } : {}),
  // Served from app.erp.io/marketing so the suite shares one origin — which
  // matters here because the shell hands sessions over to this app.
  // Keep in lockstep with BASE_PATH in lib/base-path.ts.
  basePath: "/marketing",
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  env: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || "",
    NEXT_PUBLIC_DASHBOARD_URL: process.env.NEXT_PUBLIC_DASHBOARD_URL || "",
  },
};

export default nextConfig;
