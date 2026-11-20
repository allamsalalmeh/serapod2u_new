'use server'

import { createClient, requestHostname } from '@/lib/supabase/server'
import { isSharedAuthCookie, sharedAuthCookieForHost } from '@/lib/supabase/auth-cookie-scope'
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'

export async function logoutConsumer() {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut()
    
    const cookieStore = await cookies()
    const allCookies = cookieStore.getAll()
    
    // Delete all Supabase related cookies
    const shared = sharedAuthCookieForHost(await requestHostname())
    allCookies.forEach(cookie => {
      if (cookie.name.startsWith('sb-')) {
        cookieStore.delete(cookie.name)
        if (isSharedAuthCookie(cookie.name, shared)) {
          cookieStore.set({ name: cookie.name, value: '', path: '/', domain: shared!.domain, maxAge: 0 })
        }
      }
    })
    
    // Revalidate all paths to ensure fresh data
    revalidatePath('/')
    
    return { success: true }
  } catch (error) {
    console.error('Logout error:', error)
    return { success: false, error: 'Logout failed' }
  }
}
