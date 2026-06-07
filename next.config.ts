import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@supabase/ssr", "@supabase/supabase-js"],
};

export default nextConfig;
