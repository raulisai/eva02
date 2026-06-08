/** @type {import('next').NextConfig} */
const config = {
  async rewrites() {
    const coreUrl = process.env.EVA_CORE_URL ?? 'http://localhost:3000';
    return [{ source: '/api/core/:path*', destination: `${coreUrl}/:path*` }];
  },
};

export default config;
