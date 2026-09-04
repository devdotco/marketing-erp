import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
