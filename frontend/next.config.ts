import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.DEEIX_NEXT_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "export",
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  experimental: {
    // The Fragment-ref scroll handler in Next 16.3 Preview can crash during
    // consecutive client redirects. Keep the stable handler until upstream fixes it.
    appNewScrollHandler: false,
    useTypeScriptCli: true,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
