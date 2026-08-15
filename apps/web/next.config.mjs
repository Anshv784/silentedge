/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@silentedge/config"],
  // The IDL is a build artifact at the repo root, outside this app.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
};

export default nextConfig;
