import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { guardUserOperation } from '@/lib/security-access/operation'

/** Interactive credential-admin preflight. No credentials, grants or data mutations.
 * The user's organization is server-loaded; the eventual write still passes RLS. */
export async function POST() {
  const client = await createClient()
  const { data: { user }, error } = await client.auth.getUser()
  if (error) {
    const unavailable = error.name === 'AuthRetryableFetchError' || (typeof error.status === 'number' && error.status >= 500)
    return NextResponse.json({ error: unavailable ? 'Session could not be verified' : 'Sign in again', code: unavailable ? 'sa_unavailable' : 'unauthenticated' }, { status: unavailable ? 503 : 401 })
  }
  if (!user) return NextResponse.json({ error: 'Sign in again' }, { status: 401 })
  const denied = await guardUserOperation(user.id, 'ecommerce.channel.manage', { resourceType: 'payment_gateway_settings' })
  return denied ?? NextResponse.json({ allowed: true })
}
