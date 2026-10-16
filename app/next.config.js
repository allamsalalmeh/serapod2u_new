/**
 * Resolve the Supabase host(s) from the runtime environment so the Next.js
 * image optimizer always trusts the project's own storage domain.
 *
 * This prevents the "broken login logo" class of bug: when an environment
 * (e.g. production `supabase-prd-serapod.getouch.cloud`) uses a storage host
 * that is not listed in `remotePatterns`, `next/image` rejects it with HTTP 400
 * and the image renders broken. Deriving the host from env means local,
 * staging and production each whitelist their own host with no hardcoded domain.
 */
function supabaseEnvRemotePatterns() {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_PUBLIC_URL,
    process.env.SUPABASE_URL,
  ].filter(Boolean)

  const seen = new Set()
  const patterns = []
  for (const raw of candidates) {
    try {
      const { hostname, protocol } = new URL(raw)
      if (hostname && !seen.has(hostname)) {
        seen.add(hostname)
        patterns.push({ protocol: (protocol || 'https:').replace(':', '') || 'https', hostname })
      }
    } catch {
      // Ignore malformed values; explicit/wildcard patterns below still apply.
    }
  }
  return patterns
}

/**
 * Build identifier recorded with System Logs diagnostics (lib/system-logs/environment.ts). Explicit APP_BUILD_ID wins,
 * then a deployment commit (SOURCE_COMMIT / GIT_COMMIT_SHA), then "<package version>-<UTC build time>". Development
 * servers report "dev" so hot-reload sessions never look like a deployed build.
 */
function appBuildId() {
  const clean = (value) => String(value || '').replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 64)
  if (clean(process.env.APP_BUILD_ID)) return clean(process.env.APP_BUILD_ID)
  const commit = clean(process.env.SOURCE_COMMIT || process.env.GIT_COMMIT_SHA)
  if (commit) return commit.slice(0, 12)
  if (process.env.NODE_ENV !== 'production') return 'dev'
  const version = require('./package.json').version || '0.0.0'
  return clean(`${version}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`)
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  env: {
    NEXT_PUBLIC_APP_BUILD: appBuildId(),
  },

  // Standalone output for optimized Docker/self-hosted deployments
  output: 'standalone',

  // Temporarily ignore TypeScript errors during build
  // Types are generated and available for editor autocomplete
  typescript: {
    ignoreBuildErrors: true,
  },

  // Set output file tracing root for dependency tracing in production builds
  outputFileTracingRoot: __dirname,

  // Turbopack configuration - must match outputFileTracingRoot
  // This prevents the warning: "Both outputFileTracingRoot and turbopack.root are set"
  turbopack: {
    root: __dirname,
  },

  allowedDevOrigins: ['192.168.1.5', 'localhost'],

  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
    remotePatterns: [
      // Always trust the storage host configured for THIS environment.
      ...supabaseEnvRemotePatterns(),
      // Self-hosted Supabase gateways for every environment (staging + production).
      // Wildcards cover `supabase-stg-serapod`, `supabase-prd-serapod`, `sb-stg-serapod`,
      // `sb-prd-serapod`, etc. so a new environment never reintroduces the broken-image bug.
      {
        protocol: 'https',
        hostname: '**.getouch.cloud',
      },
      {
        protocol: 'https',
        hostname: '**.getouch.co',
      },
      {
        protocol: 'https',
        hostname: 'cbqsuzctjotbhxanazhf.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'hsvmvmurvpqcdmxckhnz.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'bamybvzufxijghzqdytu.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'jqihlckqrhdxszgwuymu.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'serapod2u.com',
      },
      {
        protocol: 'https',
        hostname: 'www.serapod2u.com',
      },
      {
        protocol: 'https',
        hostname: 'dev.serapod2u.com',
      },
      {
        protocol: 'https',
        hostname: 'www.dev.serapod2u.com',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: 'sb-stg-serapod.getouch.co',
      },
      {
        protocol: 'https',
        hostname: 'supabase-stg-serapod.getouch.cloud',
      },
    ],
  },

  compiler: {
    // Keep console logs in staging for debugging
    removeConsole: process.env.NODE_ENV === 'production' && process.env.REMOVE_CONSOLE === 'true',
  },

  // Exclude problematic packages from being bundled as external modules
  // This prevents Turbopack warnings about fstream/rimraf (legacy dependencies from exceljs)
  serverExternalPackages: [
    'archiver',
    'exceljs',
    'pdfkit',
    'googleapis',
    'qrcode',
    '@vonage/server-sdk',
    '@vonage/messages',
  ],

  experimental: {
    optimizeCss: true,
    // Keep production builds responsive on the shared staging VPS.
    cpus: 2,
  },

  async redirects() {
    return [
      {
        source: '/serapp-sw.js',
        destination: '/sw.js',
        permanent: false,
      },
      {
        source: '/serapp/sw.js',
        destination: '/sw.js',
        permanent: false,
      },
    ]
  },

  async headers() {
    return [
      {
        source: '/manifest.json',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/manifest+json',
          },
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400',
          },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/javascript; charset=utf-8',
          },
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, must-revalidate',
          },
        ],
      },
      {
        source: '/icons/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
