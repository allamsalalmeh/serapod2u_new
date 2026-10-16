'use client'

import { useRouter } from 'next/navigation'
import { useHrMobile } from './HrMobileContext'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import {
  User,
  Building2,
  Briefcase,
  Mail,
  Phone,
  LogOut,
  ChevronRight,
  Shield,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { userCategoryLabel } from '@/lib/identity/display-label'

export default function HrMobileProfile() {
  const router = useRouter()
  const { userProfile, isAdmin, organizationId } = useHrMobile()
  const supabase = createClient()
  const { toast } = useToast()
  const categoryLabel = userCategoryLabel({
    orgTypeCode: userProfile.organizations?.org_type_code,
    roleCode: userProfile.role_code,
    roleName: userProfile.roles?.role_name,
  })

  /* ── Logout ─────────────────────────────────────────────────── */

  async function handleLogout() {
    try {
      await supabase.auth.signOut()
      router.replace('/login')
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to sign out',
        variant: 'destructive',
      })
    }
  }

  /* ── Render ─────────────────────────────────────────────────── */

  const initials = userProfile.full_name
    ? userProfile.full_name
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toUpperCase()
    : '?'

  return (
    <div className="px-4 pt-6 space-y-5">
      <h1 className="text-xl font-bold text-foreground">Profile</h1>

      {/* ── Avatar + Name card ────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border p-5 flex flex-col items-center gap-3">
        {userProfile.avatar_url ? (
          <img
            src={userProfile.avatar_url}
            alt="Avatar"
            className="h-20 w-20 rounded-full object-cover border-2 border-border"
          />
        ) : (
          <div className="h-20 w-20 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-2xl font-bold text-blue-600 dark:text-blue-300">
            {initials}
          </div>
        )}
        <div className="text-center">
          <h2 className="text-lg font-bold text-foreground">
            {userProfile.full_name || 'Unknown'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {categoryLabel}
          </p>
        </div>
      </div>

      {/* ── Info list ─────────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border divide-y divide-border">
        <InfoRow icon={Mail} label="Email" value={userProfile.email} />
        <InfoRow
          icon={Phone}
          label="Phone"
          value={userProfile.phone || 'Not set'}
        />
        <InfoRow
          icon={Building2}
          label="Organization"
          value={userProfile.organizations?.org_name || 'N/A'}
        />
        <InfoRow
          icon={Briefcase}
          label="Account type"
          value={categoryLabel}
        />
      </div>

      {/* ── Admin shortcut ────────────────────────────────────── */}
      {isAdmin && (
        <button
          onClick={() => router.push('/hr')}
          className="w-full flex items-center gap-3 bg-card rounded-2xl border border-border p-4 hover:bg-accent/50 transition-colors"
        >
          <div className="h-10 w-10 rounded-xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
            <Shield className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-medium text-foreground">
              Switch to Admin View
            </p>
            <p className="text-xs text-muted-foreground">
              Full HR dashboard with settings
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </button>
      )}

      {/* ── Back to dashboard ─────────────────────────────────── */}
      <button
        onClick={() => router.push('/dashboard')}
        className="w-full flex items-center gap-3 bg-card rounded-2xl border border-border p-4 hover:bg-accent/50 transition-colors"
      >
        <div className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center">
          <ChevronRight className="h-5 w-5 text-muted-foreground rotate-180" />
        </div>
        <div className="flex-1 text-left">
          <p className="text-sm font-medium text-foreground">
            Back to Main Dashboard
          </p>
          <p className="text-xs text-muted-foreground">
            Supply chain & operations
          </p>
        </div>
        <ChevronRight className="h-5 w-5 text-muted-foreground" />
      </button>

      {/* ── Logout ────────────────────────────────────────────── */}
      <Button
        variant="destructive"
        className="w-full gap-2"
        onClick={handleLogout}
      >
        <LogOut className="h-4 w-4" />
        Sign Out
      </Button>

      {/* ── Version ───────────────────────────────────────────── */}
      <p className="text-center text-[10px] text-muted-foreground pb-4">
        Serapod HR v1.0 · © {new Date().getFullYear()} Serapod
      </p>

      <div className="h-4" />
    </div>
  )
}

/* ─── Info row ────────────────────────────────────────────────────── */

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: any
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm text-foreground truncate">{value}</p>
      </div>
    </div>
  )
}
