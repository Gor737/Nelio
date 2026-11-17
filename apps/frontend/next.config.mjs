/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  rewrites: async() => [
    {
      source: "/api/v1/:path*",
      destination: process.env.BACKEND_URL + "/api/v1/:path*"
    }
  ]
};

export default nextConfig;
