import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@silentedge/config",
    "@silentedge/types",
    "@silentedge/sdk",
  ],
  // The IDL is a build artifact at the repo root, outside this app.
  outputFileTracingRoot: repoRoot,
  webpack: (config) => {
    // @arcium-hq/client 0.14.1's ESM build does `import anchor from
    // "@anchor-lang/core"`, which has no default export, so bundlers reject it.
    // The CJS build is fine, but the package's `exports` map hides it, so it is
    // referenced by path. Remove once the SDK's ESM entry is fixed.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@arcium-hq/client$": path.join(
        repoRoot,
        "node_modules/@arcium-hq/client/build/index.cjs"
      ),
    };
    // The SDK's bundle pulls node builtins for paths the browser never takes
    // (keypair files, CLI helpers). Encryption itself is pure JS plus WebCrypto.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      os: false,
      child_process: false,
    };
    return config;
  },
};

export default nextConfig;
