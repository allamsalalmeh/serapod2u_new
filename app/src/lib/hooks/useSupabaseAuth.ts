import { useEffect, useState } from 'react'
import { timeInventoryOperation, type InventoryTrace } from '@/lib/inventory/inventory-timing'
import { createClient } from '@/lib/supabase/client'

/**
 * Hook to ensure Supabase auth session is ready before making queries
 * This prevents auth.uid() from being NULL in RLS policies and handles
 * session refresh to prevent unexpected logouts
 */
export function useSupabaseAuth(timingTrace?: InventoryTrace, timingOperation = 'auth.inventory.getUser') {
  const [isReady, setIsReady] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  
  // Get the singleton Supabase client
  const supabase = createClient()

  useEffect(() => {
    let mounted = true
    let authSubscription: any = null

    const initializeAuth = async () => {
      try {
        // Check current auth state
        const { data: { user: currentUser }, error: authError } = await timeInventoryOperation(timingTrace, timingOperation, () => supabase.auth.getUser())
        
        if (!mounted) return

        if (authError) {
          // Handle refresh token errors gracefully
          if (authError.message?.includes('refresh_token_not_found') || 
              authError.message?.includes('Invalid Refresh Token') ||
              authError.message?.includes('Token has expired') ||
              authError.status === 400) {
            console.warn('⚠️ Session expired or invalid, clearing local session')
            // Clear local session
            await supabase.auth.signOut({ scope: 'local' })
            setUser(null)
            setError('Session expired. Please log in again.')
            setIsReady(true)
            // Only redirect if on a protected page
            if (typeof window !== 'undefined' && window.location.pathname.startsWith('/dashboard')) {
              window.location.href = '/login'
            }
          } else {
            console.error('❌ Auth error:', authError)
            setError(authError.message || 'Authentication error')
            setIsReady(true)
          }
        } else {
          if (currentUser) {
            console.log('✅ User authenticated:', currentUser.email)
          }
          setUser(currentUser)
          setError(null)
          setIsReady(true)
        }
      } catch (err: any) {
        if (!mounted) return
        
        console.error('❌ Error initializing auth:', err)
        // Handle network or other errors
        if (err.message?.includes('refresh_token_not_found') ||
            err.message?.includes('Invalid Refresh Token') ||
            err.message?.includes('Token has expired')) {
          await supabase.auth.signOut({ scope: 'local' })
          setUser(null)
          setIsReady(true)
          if (typeof window !== 'undefined' && window.location.pathname.startsWith('/dashboard')) {
            window.location.href = '/login'
          }
        } else {
          setError(err.message || 'Authentication failed')
          setIsReady(true)
        }
      }
    }

    // Set up auth state change listener
    const setupAuthListener = () => {
      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
        if (!mounted) return

        console.log('🔔 useSupabaseAuth - Auth event:', event)

        if (event === 'SIGNED_IN' && session?.user) {
          setUser(session.user)
          setError(null)
          setIsReady(true)
        } else if (event === 'SIGNED_OUT') {
          setUser(null)
          setError(null)
          setIsReady(true)
        } else if (event === 'TOKEN_REFRESHED' && session?.user) {
          console.log('🔄 Token refreshed in useSupabaseAuth')
          setUser(session.user)
          setError(null)
        } else if (event === 'USER_UPDATED' && session?.user) {
          setUser(session.user)
        }
      })

      authSubscription = subscription
    }

    // Initialize auth and set up listener
    initializeAuth()
    setupAuthListener()

    // Cleanup function
    return () => {
      mounted = false
      authSubscription?.unsubscribe()
    }
  }, [supabase, timingTrace, timingOperation])

  return { isReady, user, error, supabase }
}
