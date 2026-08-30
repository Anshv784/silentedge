import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/**
 * Content Security Policy.
 *
 * THREAT_MODEL T-15/T-17 listed a CSP among the mitigations for a hostile
 * script reaching the strategy before encryption. It did not exist. This is
 * that claim made true rather than deleted, because the browser is where the
 * plaintext lives and a single injected script there defeats every on-chain
 * control in this repo.
 *
 * `unsafe-inline`/`unsafe-eval` for scripts are Next's requirements for its
 * hydration bootstrap in this configuration; they are the honest weak point
 * here and are why T-15 stays UNVERIFIED rather than becoming ENFORCED.
 * `connect-src` is the part that matters most: it bounds where anything can be
 * sent, so an injected script cannot exfiltrate a draft to an arbitrary host.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Solana RPC, Jupiter quotes, Pyth's two public price services, and wallet
  // bridges. Nothing else — an injected script cannot post a draft strategy to
  // a host that is not on this list, so hosts are added one exact name at a
  // time rather than by widening this to a wildcard.
  //
  //   (candles are same-origin now — see app/api/candles/route.ts. Pyth
  //    retired the browser-callable shim on 26 Aug 2026, so the relay is
  //    server-side and no candle host belongs in this list.)
  //   hermes.pyth.network      batched prices for the tape and market list
  //
  // Both are display data. Neither can reach a signing path.
  "connect-src 'self' https://*.helius-rpc.com https://*.solana.com https://api.jup.ag https://*.jup.ag https://hermes.pyth.network wss://*.helius-rpc.com wss://*.solana.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
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
