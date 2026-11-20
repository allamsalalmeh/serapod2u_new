import { inventoryDiagnosticFetch } from '@/lib/inventory/inventory-timing'
import { createBrowserClient } from '@supabase/ssr'
import { Database } from '@/types/database'
import { authCookieOptionsForHost } from '@/lib/supabase/auth-cookie-scope'

// Singleton instance to prevent multiple Supabase clients
let client: ReturnType<typeof createBrowserClient<Database>> | null = null

export function createClient() {
  // Return existing client if already created
  if (client) {
    return client
  }

  // Get environment variables with validation
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Validate environment variables are present
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing Supabase environment variables. ' +
      'Please ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.'
    )
  }

  // Create new client with proper configuration
  const cookieScope = authCookieOptionsForHost(typeof window === 'undefined' ? null : window.location.hostname)
  const diagnostics = process.env.NODE_ENV === 'development' ? { global: { fetch: inventoryDiagnosticFetch } } : null
  client = createBrowserClient<Database>(
    supabaseUrl,
    supabaseAnonKey,
    diagnostics || 'cookieOptions' in cookieScope ? { ...diagnostics, ...cookieScope } : undefined
  )

  return client
}

// Export a function to reset the client (useful for testing or logout)
export function resetClient() {
  client = null
}

/**
 * Force clear all Supabase storage data from browser
 * This is more aggressive than signOut() and clears all cached session data
 */
export function forceCleanStorage() {
  if (typeof window === 'undefined') return
  
  try {
    // Clear all Supabase-related localStorage items
    const localKeys = Object.keys(localStorage)
    localKeys.forEach(key => {
      if (key.includes('supabase') || key.includes('sb-')) {
        localStorage.removeItem(key)
      }
    })
    
    // Clear all Supabase-related sessionStorage items
    const sessionKeys = Object.keys(sessionStorage)
    sessionKeys.forEach(key => {
      if (key.includes('supabase') || key.includes('sb-')) {
        sessionStorage.removeItem(key)
      }
    })
    
    console.log('🧹 Supabase storage cleaned')
  } catch (error) {
    console.error('Error cleaning storage:', error)
  }
}