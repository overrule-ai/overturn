import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@overturn/shared"],
};

export default config;
