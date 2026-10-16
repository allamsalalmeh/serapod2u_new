'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle, AlertCircle, Loader2, User, Database, Key } from 'lucide-react'

export default function AuthDiagnostic() {
  const [loading, setLoading] = useState(false)
  const [authUser, setAuthUser] = useState<any>(null)
  const [dbUser, setDbUser] = useState<any>(null)
  const [diagnostics, setDiagnostics] = useState<Array<{step: string, success: boolean, message: string, data?: any}>>([])
  const supabase = createClient()

  const runDiagnostics = async () => {
    setLoading(true)
    setDiagnostics([])
    const steps: Array<{step: string, success: boolean, message: string, data?: any}> = []

    try {
      // Step 1: Check Supabase Auth user
      console.log('Checking Supabase Auth...')
      const { data: { user: authUserData }, error: authError } = await supabase.auth.getUser()
      
      if (authError) {
        steps.push({step: 'Check Supabase Auth', success: false, message: authError.message})
      } else if (!authUserData) {
        steps.push({step: 'Check Supabase Auth', success: false, message: 'No authenticated user found'})
      } else {
        setAuthUser(authUserData)
        steps.push({step: 'Check Supabase Auth', success: true, message: `Found auth user: ${authUserData.email}`, data: authUserData})
      }

      // Step 2: Look for user in database by email using the database function
      console.log('Checking database user by email...')
      const { data: dbUserData, error: dbError } = await supabase
        .rpc('get_user_by_email', { p_email: 'super@dev.com' })

      if (dbError) {
        steps.push({step: 'Check DB user by email', success: false, message: dbError.message})
      } else if (!dbUserData || dbUserData.length === 0) {
        steps.push({step: 'Check DB user by email', success: true, message: 'User not found in database. They will be created on first sign in.', data: null})
      } else {
        const userData = Array.isArray(dbUserData) ? dbUserData[0] : dbUserData
        setDbUser(userData)
        steps.push({step: 'Check DB user by email', success: true, message: `Found DB user: ${userData.full_name || userData.email}`, data: userData})
      }

      // Step 3: Check if UUID matches (get_user_by_email returns rows)
      const firstDbUser = Array.isArray(dbUserData) ? dbUserData[0] : dbUserData
      if (authUserData && firstDbUser) {
        if (authUserData.id === firstDbUser.id) {
          steps.push({step: 'UUID Match Check', success: true, message: 'Auth and DB user UUIDs match perfectly'})
        } else {
          steps.push({step: 'UUID Match Check', success: false, message: `UUID mismatch: Auth=${authUserData.id}, DB=${firstDbUser.id}`})
        }
      }

      // Step 4: Check organizations table
      console.log('Checking organizations...')
      const { data: orgs, error: orgError } = await supabase
        .from('organizations')
        .select('*')
        .limit(5)

      if (orgError) {
        steps.push({step: 'Check Organizations', success: false, message: orgError.message})
      } else {
        steps.push({step: 'Check Organizations', success: true, message: `Found ${orgs?.length || 0} organizations`, data: orgs})
      }

      // Step 5: Check roles table
      console.log('Checking roles...')
      const { data: roles, error: roleError } = await supabase
        .from('roles')
        .select('*')
        .limit(5)

      if (roleError) {
        steps.push({step: 'Check Roles', success: false, message: roleError.message})
      } else {
        steps.push({step: 'Check Roles', success: true, message: `Found ${roles?.length || 0} roles`, data: roles})
      }

      setDiagnostics(steps)

    } catch (error) {
      console.error('Diagnostic error:', error)
      steps.push({step: 'Diagnostics', success: false, message: `Unexpected error: ${error}`})
      setDiagnostics(steps)
    } finally {
      setLoading(false)
    }
  }

  const createAuthUser = async () => {
    try {
      setLoading(true)
      console.log('Creating auth user...')
      
      const { data, error } = await supabase.auth.signUp({
        email: 'super@dev.com',
        password: 'SuperAdmin123!',
        options: {
          data: {
            full_name: 'Super Administrator'
          }
        }
      })

      if (error) {
        setDiagnostics(prev => [...prev, {step: 'Create Auth User', success: false, message: error.message}])
      } else {
        setDiagnostics(prev => [...prev, {step: 'Create Auth User', success: true, message: `Auth user created: ${data.user?.email}`, data: data.user}])
        // Automatically run diagnostics again to check the new state
        setTimeout(() => runDiagnostics(), 1000)
      }
    } catch (error) {
      setDiagnostics(prev => [...prev, {step: 'Create Auth User', success: false, message: `Error: ${error}`}])
    } finally {
      setLoading(false)
    }
  }

  const signInAuthUser = async () => {
    try {
      setLoading(true)
      console.log('Signing in auth user...')
      
      const { data, error } = await supabase.auth.signInWithPassword({
        email: 'super@dev.com',
        password: 'SuperAdmin123!'
      })

      if (error) {
        setDiagnostics(prev => [...prev, {step: 'Sign In Auth User', success: false, message: error.message}])
      } else {
        setDiagnostics(prev => [...prev, {step: 'Sign In Auth User', success: true, message: `Signed in: ${data.user?.email}`, data: data.user}])
        // Automatically run diagnostics again to check the new state
        setTimeout(() => runDiagnostics(), 1000)
      }
    } catch (error) {
      setDiagnostics(prev => [...prev, {step: 'Sign In Auth User', success: false, message: `Error: ${error}`}])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    runDiagnostics()
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-5 h-5" />
            Authentication Diagnostics
          </CardTitle>
          <CardDescription>
            Diagnose authentication issues and check database connections
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            <Button 
              onClick={runDiagnostics} 
              disabled={loading}
              variant="outline"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Running Diagnostics...
                </>
              ) : (
                <>
                  <Database className="w-4 h-4 mr-2" />
                  Run Diagnostics
                </>
              )}
            </Button>

            <Button 
              onClick={createAuthUser} 
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <User className="w-4 h-4 mr-2" />
                  Create Auth User
                </>
              )}
            </Button>

            <Button 
              onClick={signInAuthUser} 
              disabled={loading}
              variant="secondary"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Signing In...
                </>
              ) : (
                <>
                  <Key className="w-4 h-4 mr-2" />
                  Sign In
                </>
              )}
            </Button>
          </div>

          {diagnostics.length > 0 && (
            <div className="space-y-3">
              <h3 className="font-semibold">Diagnostic Results:</h3>
              {diagnostics.map((result, index) => (
                <div key={index} className={`p-3 rounded-lg border ${result.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                  <div className="flex items-start gap-2">
                    {result.success ? (
                      <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-600 mt-0.5" />
                    )}
                    <div className="flex-1">
                      <div className={result.success ? 'text-green-800' : 'text-red-800'}>
                        <strong>{result.step}:</strong> {result.message}
                        {result.data && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-sm text-gray-600">View Data</summary>
                            <pre className="mt-2 text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40">
                              {JSON.stringify(result.data, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {authUser && (
            <Card className="bg-blue-50">
              <CardHeader>
                <CardTitle className="text-lg">Current Auth User</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <p><strong>ID:</strong> {authUser.id}</p>
                  <p><strong>Email:</strong> {authUser.email}</p>
                  <p><strong>Created:</strong> {new Date(authUser.created_at).toLocaleString()}</p>
                  <p><strong>Email Confirmed:</strong> {authUser.email_confirmed_at ? 'Yes' : 'No'}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {dbUser && (
            <Card className="bg-green-50">
              <CardHeader>
                <CardTitle className="text-lg">Database User</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <p><strong>ID:</strong> {dbUser.id}</p>
                  <p><strong>Email:</strong> {dbUser.email}</p>
                  <p><strong>Name:</strong> {dbUser.full_name}</p>
                  <p><strong>Role:</strong> {dbUser.roles?.role_name} (Level: {dbUser.roles?.role_level})</p>
                  <p><strong>Organization:</strong> {dbUser.organizations?.org_name}</p>
                  <p><strong>Active:</strong> {dbUser.is_active ? 'Yes' : 'No'}</p>
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  )
}