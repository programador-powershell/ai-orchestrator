import type { NextConfig } from "next";

/**
 * Next como EMPACOTADOR de SPA dentro do Tauri: export estático para ../out
 * (frontendDist do tauri.conf.json). Sem SSR — o App monta com ssr:false em
 * app/page.tsx, preservando o comportamento do SPA Vite anterior.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@ai-orchestrator/contracts"],
  reactStrictMode: true
};

export default nextConfig;
