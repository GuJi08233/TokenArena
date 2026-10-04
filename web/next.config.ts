import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // `radix-ui` re-exports every primitive. Without this, the shadcn
    // components that import it from Server Components pull all of them in
    // as client references.
    optimizePackageImports: ["radix-ui"],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "linux.do",
      },
      {
        protocol: "https",
        hostname: "watcha.tos-cn-beijing.volces.com",
      },
    ],
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
