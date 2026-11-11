'use client'

import { Package, PlusCircle, BarChart3, FileText, ShoppingCart, MessageCircle, ExternalLink, Landmark } from 'lucide-react'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import { useNavAccess } from '@/hooks/useNavAccess'
import { canAccessSupplyChainView } from '@/modules/supply-chain/supplyChainNav'
import DashboardStatistics from './DashboardStatistics'
import ActionRequired from './ActionRequired'
import RecentActivities from './RecentActivities'

interface UserProfile {
  id: string
  email: string
  role_code: string
  organization_id: string | null
  is_active: boolean
  organizations: {
    id: string
    org_name: string
    org_type_code: string
    org_code: string
  } | null
  roles: {
    role_name: string
    role_level: number
  }
}

interface DashboardOverviewProps {
  userProfile: UserProfile
  onViewChange: (view: string) => void
  bannerImageUrl?: string | null
}

export default function DashboardOverview({ userProfile, onViewChange }: DashboardOverviewProps) {
  const navAccess = useNavAccess()
  const handleViewDocument = (orderId: string, documentId: string, docType: 'PO' | 'INVOICE' | 'PAYMENT' | 'RECEIPT' | 'PAYMENT_REQUEST', docNo?: string) => {
    sessionStorage.setItem('trackingOrderId', orderId)
    sessionStorage.setItem('selectedDocumentId', documentId)
    sessionStorage.setItem('selectedDocumentType', docType)

    let initialTab = 'po'
    if (docType === 'INVOICE') {
      initialTab = docNo?.includes('-DEP') ? 'depositInvoice' : 'invoice'
    } else if (docType === 'PAYMENT') {
      initialTab = docNo?.includes('-BAL') ? 'balancePayment' : 'depositPayment'
    } else if (docType === 'RECEIPT') {
      initialTab = 'receipt'
    } else if (docType === 'PAYMENT_REQUEST') {
      initialTab = 'balanceRequest'
    }

    sessionStorage.setItem('selectedDocumentTab', initialTab)
    onViewChange('track-order')
  }

  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 17) return 'Good afternoon'
    return 'Good evening'
  }

  // D2H sits behind the same access rule as its Order Management nav item
  // (HQ/DIST, role level 40 and above), so the shortcut is hidden rather than
  // dropping an unauthorized user onto the page.
  const canOrderD2H = canAccessSupplyChainView(
    'distributor-order',
    userProfile.organizations?.org_type_code,
    userProfile.roles?.role_level,
  )
  const orgType = (userProfile.organizations?.org_type_code || '').toUpperCase()
  const canOpenSerapp = orgType === 'HQ' || orgType === 'DIST'
  // Finance follows the sidebar entry and the /finance page guard (Security & Access 'finance').
  const canOpenFinance = navAccess.allows('finance')

  const quickLinks = [
    { label: 'Orders', icon: Package, view: 'orders' },
    { label: 'Create Order', icon: PlusCircle, view: 'create-order' },
    ...(canOrderD2H ? [{ label: 'D2H Order', icon: ShoppingCart, view: 'distributor-order' }] : []),
    { label: 'Reporting', icon: BarChart3, view: 'reporting' },
    { label: 'Documents', icon: FileText, view: 'track-order' },
    ...(canOpenFinance ? [{ label: 'Finance', icon: Landmark, view: 'finance' }] : []),
  ]

  return (
    <div className="sera-dashboard sera-module-landing">
      <ModuleLightHeader
        eyebrow="Dashboard"
        title={getGreeting()}
        actions={
          <div className="sera-dashboard__meta">
            {userProfile.roles?.role_name ? (
              <span className="sera-dashboard__meta-pill sera-dashboard__meta-pill--role">
                {userProfile.roles.role_name}
              </span>
            ) : null}
            {userProfile.organizations?.org_code ? (
              <span className="sera-dashboard__meta-pill">
                {userProfile.organizations.org_code}
              </span>
            ) : null}
          </div>
        }
      />

      <section className="sera-dashboard__section sera-dashboard-enter">
        <p className="sera-dashboard__section-label">Quick access</p>
        <div className="sera-dashboard__quick-links">
          {quickLinks.map(({ label, icon: Icon, view }) => (
            <button
              key={view}
              type="button"
              className="sera-dashboard__quick-link"
              onClick={() => onViewChange(view)}
            >
              <Icon strokeWidth={1.75} />
              {label}
            </button>
          ))}
          {canOpenSerapp ? (
            <a
              href="/serapp"
              target="_blank"
              rel="noopener noreferrer"
              className="sera-dashboard__quick-link"
              aria-label="Open SerApp in a new tab"
            >
              <MessageCircle strokeWidth={1.75} />
              SerApp
              <ExternalLink strokeWidth={1.75} className="sera-dashboard__quick-link-external" />
            </a>
          ) : null}
        </div>
      </section>

      <section className="sera-dashboard__section sera-dashboard-enter sera-dashboard-enter--1">
        <p className="sera-dashboard__section-label">At a glance</p>
        <DashboardStatistics userProfile={userProfile} />
      </section>

      <section className="sera-dashboard__section sera-dashboard-enter sera-dashboard-enter--2">
        <p className="sera-dashboard__section-label">Your workspace</p>
        <div className="sera-dashboard__grid">
          <ActionRequired
            userProfile={userProfile}
            onViewDocument={handleViewDocument}
            onViewChange={onViewChange}
          />
          <RecentActivities userProfile={userProfile} />
        </div>
      </section>
    </div>
  )
}
