import { describe, expect, it } from 'vitest'
import { appBuild, resolveRuntimeEnvironment } from './environment'

const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv

describe('System Logs environment (trusted runtime configuration only)', () => {
  it('never records a local dev server as staging, even though localhost shares the staging database', () => {
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'development', NEXT_PUBLIC_APP_URL: 'http://localhost:3000', NEXT_PUBLIC_SUPABASE_URL: 'https://supabase-stg-serapod.getouch.cloud' }))).toBe('local')
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }))).toBe('local')
  })

  it('derives deployed environments from the configured app host', () => {
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://stg.serapod2u.com' }))).toBe('staging')
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://dev.serapod2u.com' }))).toBe('development')
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://serapod2u.com' }))).toBe('production')
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', COOLIFY_FQDN: 'stg.serapod2u.com,www.stg.serapod2u.com' }))).toBe('staging')
  })

  it('honours an explicit SYSTEM_LOG_ENVIRONMENT and ignores invalid values', () => {
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://serapod2u.com', SYSTEM_LOG_ENVIRONMENT: 'staging' }))).toBe('staging')
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://serapod2u.com', SYSTEM_LOG_ENVIRONMENT: 'prod-ish' }))).toBe('production')
  })

  it('reports test and unknown builds safely', () => {
    expect(resolveRuntimeEnvironment(env({ NODE_ENV: 'test' }))).toBe('test')
    expect(appBuild(env({ NEXT_PUBLIC_APP_BUILD: '0.1.0-202610070300' }))).toBe('0.1.0-202610070300')
    expect(appBuild(env({ NEXT_PUBLIC_APP_BUILD: 'bad build id; drop table' }))).toBe('unknown')
    expect(appBuild(env({}))).toBe('unknown')
  })
})
