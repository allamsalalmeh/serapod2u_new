'use client'

import { createContext, useContext, type ReactNode } from 'react'

/* ─── User profile shape (matches getHrPageContext output) ────────── */

export interface HrUserProfile {
  id: string
  email: string
  full_name: string | null
  phone: string | null
  role_code: string
  organization_id: string | null
  avatar_url: string | null
  organizations: {
    id: string
    org_name: string
    org_type_code: string
    org_code: string
  }
  roles: {
    role_name: string
    role_level: number
  }
  department_id?: string | null
  manager_user_id?: string | null
}

/* ─── Context value ───────────────────────────────────────────────── */

interface HrMobileContextType {
  userProfile: HrUserProfile
  /** May approve leave (Security & Access: hr.leave.approve with the HR module entry). Not a legacy role level. */
  isManager: boolean
  /** Holds HR administration (Security & Access: hr.module.view). Not a legacy role level. */
  isAdmin: boolean
  /** May open the read-only staff organization chart (Security & Access). */
  canViewOrgChart: boolean
  organizationId: string
}

const HrMobileContext = createContext<HrMobileContextType | null>(null)

/* ─── Hook ────────────────────────────────────────────────────────── */

export function useHrMobile() {
  const ctx = useContext(HrMobileContext)
  if (!ctx) {
    throw new Error('useHrMobile must be used inside <HrMobileProvider>')
  }
  return ctx
}

/* ─── Provider ────────────────────────────────────────────────────── */

export function HrMobileProvider({
  userProfile,
  canApproveLeave = false,
  canAdministerHr = false,
  canViewOrgChart = false,
  children,
}: {
  userProfile: HrUserProfile
  canApproveLeave?: boolean
  canAdministerHr?: boolean
  canViewOrgChart?: boolean
  children: ReactNode
}) {
  const isAdmin = canAdministerHr
  const isManager = canApproveLeave
  const organizationId =
    userProfile.organization_id ?? userProfile.organizations?.id ?? ''

  return (
    <HrMobileContext.Provider
      value={{ userProfile, isManager, isAdmin, canViewOrgChart, organizationId }}
    >
      {children}
    </HrMobileContext.Provider>
  )
}
