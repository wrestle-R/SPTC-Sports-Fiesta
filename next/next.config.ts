import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ] }];
  },
  allowedDevOrigins: ["192.168.0.105"],
  transpilePackages: ["@sports-fiesta/domain", "@sports-fiesta/theme"],
  turbopack: { root: __dirname },
};

export default nextConfig;
