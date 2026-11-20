'use server'

import { createClient, requestHostname } from '@/lib/supabase/server'
import { isSharedAuthCookie, sharedAuthCookieForHost } from '@/lib/supabase/auth-cookie-scope'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'

export async function signOut() {
  const supabase = await createClient()
  
  // Sign out from Supabase
  const { error } = await supabase.auth.signOut()
  
  if (error) {
    console.error('Sign out error:', error)
  }
  
  // Clear all Supabase cookies manually
  const cookieStore = await cookies()
  const allCookies = cookieStore.getAll()
  
  // Delete all cookies that start with 'sb-'
  const shared = sharedAuthCookieForHost(await requestHostname())
  allCookies.forEach(cookie => {
    if (cookie.name.startsWith('sb-')) {
      cookieStore.delete(cookie.name)
      if (isSharedAuthCookie(cookie.name, shared)) {
        cookieStore.set({ name: cookie.name, value: '', path: '/', domain: shared!.domain, maxAge: 0 })
      }
    }
  })
  
  // Revalidate all paths to clear server cache
  revalidatePath('/', 'layout')
  
  // Redirect to login
  redirect('/login')
}
