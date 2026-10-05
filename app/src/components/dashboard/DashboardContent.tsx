'use client'

import { useState, useEffect, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import { usePermissions } from '@/hooks/usePermissions'
import ProductsView from '@/components/products/ProductsView'
import AddProductView from '@/components/products/AddProductView'
import ViewProductDetails from '@/components/products/ViewProductDetails'
import EditProductView from '@/components/products/EditProductView'
import ProductManagement from '@/components/products/ProductManagement'
import OrdersView from '@/components/orders/OrdersView'
import CreateOrderView from '@/components/orders/CreateOrderView'
import ViewOrderDetailsView from '@/components/orders/ViewOrderDetailsView'
import TrackOrderView from '@/components/dashboard/views/orders/TrackOrderView'
import InventoryView from '@/components/inventory/InventoryView'
import InventorySettingsView from '@/components/inventory/InventorySettingsView'
import AddStockView from '@/components/inventory/AddStockView'
import StockAdjustmentView from '@/components/inventory/StockAdjustmentView'
import StockTransferView from '@/components/inventory/StockTransferView'
import StockMovementReportView from '@/components/inventory/StockMovementReportView'
import MigrationView from '@/components/migration/MigrationView'
import OrganizationsView from '@/components/organizations/OrganizationsView'
import AddOrganizationView from '@/components/organizations/AddOrganizationView'
import EditOrganizationView from '@/components/organizations/EditOrganizationView'
import DistributorsView from '@/components/distributors/DistributorsView'
import UsersView from '@/components/users/UsersView'
import MyProfileViewNew from '@/components/dashboard/views/MyProfileViewNew'

import ReportingView from '@/components/dashboard/views/reporting/ReportingView'
import DashboardOverview from '@/components/dashboard/DashboardOverview'
import HrPeopleView from '@/components/hr/HrPeopleView'
import HrOrgChartView from '@/components/hr/HrOrgChartView'
import HrDepartmentsView from '@/components/hr/HrDepartmentsView'
import HrPositionsView from '@/components/hr/HrPositionsView'
import HrSettingsView from '@/components/hr/HrSettingsView'
import HrAttendanceClockView from '@/components/hr/modules/HrAttendanceClockView'
import HrAttendanceTimesheetsView from '@/components/hr/modules/HrAttendanceTimesheetsView'
import HrLeaveTypesView from '@/components/hr/modules/HrLeaveTypesView'
import HrLeaveRequestsView from '@/components/hr/modules/HrLeaveRequestsView'
import HrLeaveApprovalFlowView from '@/components/hr/modules/HrLeaveApprovalFlowView'
import HrPayrollSalaryView from '@/components/hr/modules/HrPayrollSalaryView'
import HrPayrollAllowancesView from '@/components/hr/modules/HrPayrollAllowancesView'
import HrPayrollPayslipsView from '@/components/hr/modules/HrPayrollPayslipsView'
import HrKpiModuleView from '@/components/hr/modules/HrKpiModuleView'
import HrPerformanceAppraisalsView from '@/components/hr/modules/HrPerformanceAppraisalsView'
import HrPerformanceReviewsView from '@/components/hr/modules/HrPerformanceReviewsView'
import HrSettingsApprovalRulesView from '@/components/hr/modules/HrSettingsApprovalRulesView'
import HrSettingsPermissionsView from '@/components/hr/modules/HrSettingsPermissionsView'
import HrPublicHolidaysView from '@/components/hr/modules/HrPublicHolidaysView'
import HRTopNav from '@/modules/hr/components/HRTopNav'
import HrLandingView from '@/modules/hr/components/HrLandingView'
import HrConfigurationView from '@/modules/hr/components/HrConfigurationView'
import HrAccountingView from '@/modules/hr/components/HrAccountingView'
import HrAiAssistant from '@/modules/hr/components/HrAiAssistant'
import ModuleAiAssistant, {
  financeAssistantConfig,
  supplyChainAssistantConfig,
  customerGrowthAssistantConfig,
} from '@/components/ai/ModuleAiAssistant'
// Finance Module Components
import FinanceTopNav from '@/modules/finance/components/FinanceTopNav'
import FinanceLandingView from '@/modules/finance/components/FinanceLandingView'
import FinanceConfigurationView from '@/modules/finance/components/FinanceConfigurationView'
import FinancePlaceholderView from '@/modules/finance/components/FinancePlaceholderView'
import FinanceCurrencySettingsView from '@/modules/finance/components/FinanceCurrencySettingsView'
import GLJournalView from '@/components/accounting/GLJournalView'
import PendingPostingsView from '@/components/accounting/PendingPostingsView'
import ARInvoicesView from '@/components/accounting/ARInvoicesView'
import ARReceiptsView from '@/components/accounting/ARReceiptsView'
import ARAgingView from '@/components/accounting/ARAgingView'
import APBillsView from '@/components/accounting/APBillsView'
import APPaymentsView from '@/components/accounting/APPaymentsView'
import APAgingView from '@/components/accounting/APAgingView'
import TrialBalanceView from '@/components/accounting/reports/TrialBalanceView'
import ProfitLossView from '@/components/accounting/reports/ProfitLossView'
import BalanceSheetView from '@/components/accounting/reports/BalanceSheetView'
import GLDetailView from '@/components/accounting/reports/GLDetailView'
import BankAccountsView from '@/components/accounting/BankAccountsView'
import BankReconciliationView from '@/components/accounting/BankReconciliationView'
import BankStatementsView from '@/components/accounting/BankStatementsView'
import CashFlowView from '@/components/accounting/CashFlowView'
import ChartOfAccountsTab from '@/components/settings/ChartOfAccountsTab'
import DefaultAccountsSettings from '@/components/settings/DefaultAccountsSettings'
import PostingRulesSettings from '@/components/settings/PostingRulesSettings'
import FinancePermissionsSettings from '@/components/settings/FinancePermissionsSettings'
import AccountingTab from '@/components/settings/AccountingTab'
// Settings Module Components
import SettingsTopNav from '@/modules/settings/components/SettingsTopNav'
import SettingsLandingView from '@/modules/settings/components/SettingsLandingView'
import NotificationsLandingView from '@/modules/notifications/components/NotificationsLandingView'
import NotificationsTopNav from '@/modules/notifications/components/NotificationsTopNav'
import SettingsView from '@/components/settings/SettingsView'
import NotificationTypesTab from '@/components/settings/NotificationTypesTab'
import NotificationProvidersTab from '@/components/settings/NotificationProvidersTab'
import NotificationMonitor from '@/components/settings/monitor/NotificationMonitor'
import DocumentTemplateTab from '@/components/settings/DocumentTemplateTab'
import DocSequenceTab from '@/components/settings/DocSequenceTab'
import AuthorizationTab from '@/components/settings/AuthorizationTab'
import SecurityAccessView from '@/components/security-access/SecurityAccessView'
import DangerZoneTab from '@/components/settings/DangerZoneTab'
import AiProviderSettingsCard from '@/modules/hr/components/AiProviderSettingsCard'
import AiUsageDashboard from '@/modules/settings/components/AiUsageDashboard'
import PaymentGatewaySettingsView from '@/modules/settings/components/PaymentGatewaySettingsView'
import { createClient } from '@/lib/supabase/client'
import { getStorageUrl } from '@/lib/utils'
// QR Tracking Components
import QRBatchesView from '@/components/dashboard/views/qr-tracking/QRBatchesView'
import ManufacturerScanView2 from '@/components/dashboard/views/qr-tracking/ManufacturerScanView2'
import WarehouseReceiveView2 from '@/components/dashboard/views/qr-tracking/WarehouseReceiveView2'
import WarehouseShipV2 from '@/components/dashboard/views/qr-tracking/WarehouseShipV2'
import ConsumerScanView from '@/components/dashboard/views/qr-tracking/ConsumerScanView'

import DistributorOrderView from '@/components/orders/DistributorOrderView'
import ShopOrderView from '@/components/orders/ShopOrderView'
import DistributorIncentiveView from '@/components/supply-chain/DistributorIncentiveView'
// Consumer Engagement Components
import LuckyDrawView from '@/components/dashboard/views/consumer-engagement/LuckyDrawView'
import ConsumerActivationsView from '@/components/dashboard/views/consumer-engagement/ConsumerActivationsView'
import ProductCatalogView from '@/components/dashboard/views/consumer-engagement/ProductCatalogView'
import RedeemGiftManagementView from '@/components/redeem-gift/RedeemGiftManagementView'
import JourneyBuilderV2 from '@/components/journey/JourneyBuilderV2'
import ScratchCardGameView from '@/components/dashboard/views/consumer-engagement/ScratchCardGameView'
import QualityIssuesView from '@/components/manufacturer/QualityIssuesView'
import ReturnProductView from '@/components/supply-chain/returns/ReturnProductView'
import ReturnSettingsView from '@/components/supply-chain/returns/ReturnSettingsView'
import ReturnReportingView from '@/components/supply-chain/returns/ReturnReportingView'
import SupplyChainLandingView from '@/modules/supply-chain/components/SupplyChainLandingView'
import SupplyChainTopNav from '@/modules/supply-chain/components/SupplyChainTopNav'
import { canAccessSupplyChainView, isSupplyChainViewId, supplyChainViewToPath, supplyChainOrganizationPath, supplyChainProductPath, supplyChainOrderPath } from '@/modules/supply-chain/supplyChainNav'
import LoyaltyLandingView from '@/modules/loyalty/components/LoyaltyLandingView'
import LoyaltyTopNav from '@/modules/loyalty/components/LoyaltyTopNav'
import { isLoyaltyViewId, loyaltyHrefForView } from '@/modules/loyalty/loyaltyNav'
// CRM Module Components
import CrmLandingView from '@/modules/crm/components/CrmLandingView'
import CrmTopNav from '@/modules/crm/components/CrmTopNav'
import { isCrmViewId, crmHrefForView } from '@/modules/crm/crmNav'
// Marketing Module Components
import MarketingLandingView from '@/modules/marketing/components/MarketingLandingView'
import MarketingTopNav from '@/modules/marketing/components/MarketingTopNav'
import LandingPagesAdminView from '@/modules/marketing/components/LandingPagesAdminView'
import { isMarketingViewId, marketingHrefForView } from '@/modules/marketing/marketingNav'
// Catalog Module Components
import CatalogLandingView from '@/modules/catalog/components/CatalogLandingView'
import CatalogTopNav from '@/modules/catalog/components/CatalogTopNav'
import { isCatalogViewId, catalogHrefForView } from '@/modules/catalog/catalogNav'
// Customer & Growth Module Components
import CustomerGrowthLandingView from '@/modules/customer-growth/components/CustomerGrowthLandingView'
import CustomerGrowthTopNav from '@/modules/customer-growth/components/CustomerGrowthTopNav'
import { ecommerceHrefForView, isCustomerGrowthViewId, isEcommerceViewId } from '@/modules/customer-growth/customerGrowthNav'
import HeroBannersUnifiedView from '@/modules/ecommerce/components/HeroBannersUnifiedView'
import StoreOrdersView from '@/modules/ecommerce/components/StoreOrdersView'
// RoadTour Module Components
import { RoadtourLandingView } from '@/modules/roadtour/components/RoadtourLandingView'
import { RoadtourCampaignsView } from '@/modules/roadtour/components/RoadtourCampaignsView'
import { RoadtourQrManagementView } from '@/modules/roadtour/components/RoadtourQrManagementView'
import { RoadtourSurveyHubView } from '@/modules/roadtour/components/RoadtourSurveyHubView'
import { RoadtourVisitsView } from '@/modules/roadtour/components/RoadtourVisitsView'
import { RoadtourSettingsView } from '@/modules/roadtour/components/RoadtourSettingsView'
import { RoadtourWhatsAppMonitoringView } from '@/modules/roadtour/components/RoadtourWhatsAppMonitoringView'
import { MonthlyOverviewView } from '@/modules/roadtour/components/reporting/MonthlyOverviewView'
import { AmPerformanceView } from '@/modules/roadtour/components/reporting/AmPerformanceView'
import { ShopFollowUpView } from '@/modules/roadtour/components/reporting/ShopFollowUpView'
import { ShopPerformanceView } from '@/modules/roadtour/components/reporting/ShopPerformanceView'
import { ShopDrilldownView } from '@/modules/roadtour/components/reporting/ShopDrilldownView'
import { MonthlyKpiPerformanceReportView } from '@/modules/roadtour/components/analytics/MonthlyKpiPerformanceReportView'
import { RoadtourKpiSettingsView } from '@/modules/roadtour/components/RoadtourKpiSettingsView'
import RoadtourTopNav from '@/modules/roadtour/components/RoadtourTopNav'
import GlobalPageChrome from '@/components/layout/GlobalPageChrome'
import { isRoadtourViewId, resolveRoadtourViewId, roadtourHrefForView } from '@/modules/roadtour/roadtourNav'
import UserProfileWrapper from '@/components/users/UserProfileWrapper'
import MarketingPage from '@/app/loyalty/marketing/page'
import { AdminSupportInboxV2 } from '@/components/support/AdminSupportInboxV2'

interface UserProfile {
  id: string
  email: string
  full_name: string | null
  phone: string | null
  role_code: string
  organization_id: string | null
  avatar_url: string | null
  signature_url: string | null
  is_active: boolean | null
  is_verified: boolean | null
  email_verified_at: string | null
  phone_verified_at: string | null
  last_login_at: string | null
  last_login_ip: unknown
  created_at: string | null
  updated_at: string | null
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
}

interface DashboardContentProps {
  userProfile: UserProfile
  initialView?: string
  initialOrderId?: string
  initialTargetId?: string
  /** Organization id parsed from a Supply Chain deep link (e.g. /supply-chain/organizations/<id>/edit) */
  initialOrgId?: string
  /** Product id parsed from /supply-chain/products/<id>[/edit] */
  initialProductId?: string
  children?: ReactNode
}

export default function DashboardContent({ userProfile, initialView, initialOrderId, initialTargetId, initialOrgId, initialProductId, children }: DashboardContentProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { hasPermission } = usePermissions(
    userProfile.roles.role_level,
    userProfile.role_code,
    (userProfile as any).department_id
  )

  const canEditHr =
    userProfile.roles.role_level <= 20 ||
    hasPermission('manage_org_chart') ||
    hasPermission('edit_org_settings')

  const canEditFinance =
    userProfile.roles.role_level <= 20 ||
    hasPermission('edit_org_settings') ||
    hasPermission('view_settings')

  const orgTypeCode = userProfile.organizations?.org_type_code
  const roleLevel = userProfile.roles?.role_level

  // ── Sidebar collapse state (persisted in localStorage) ──────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('ui.sidebarCollapsed') === 'true'
    }
    return false
  })

  // ── Module banner image configs (all modules) ──────────────────
  const [moduleBannerUrls, setModuleBannerUrls] = useState<Record<string, string | null>>({
    dashboard: null, supply: null, customer: null, hr: null, finance: null, settings: null,
  })

  useEffect(() => {
    async function loadModuleBanners() {
      if (!userProfile.organization_id) return
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('organizations')
          .select('settings')
          .eq('id', userProfile.organization_id)
          .single()

        let settings: Record<string, any> = {}
        if (typeof data?.settings === 'string') {
          try { settings = JSON.parse(data.settings) } catch { settings = {} }
        } else if (typeof data?.settings === 'object' && data?.settings !== null) {
          settings = data.settings as Record<string, any>
        }

        const banners = settings?.module_banners || {}
        const resolved: Record<string, string | null> = {}
        const moduleKeys = ['dashboard', 'supply', 'customer', 'hr', 'finance', 'settings']
        for (const key of moduleKeys) {
          // For HR, also check legacy path as fallback
          const path = banners[key] || (key === 'hr' ? settings?.hr_config?.banner_image_url : null)
          if (path) {
            resolved[key] = path.startsWith('http') ? path : getStorageUrl(path)
          } else {
            resolved[key] = null
          }
        }
        setModuleBannerUrls(resolved)
      } catch (e) {
        console.error('Failed to load module banner configs:', e)
      }
    }
    loadModuleBanners()
  }, [userProfile.organization_id])

  // Check for stored view from sessionStorage (set by EngagementShell when navigating from other pages)
  const getInitialView = () => {
    if (typeof window !== 'undefined') {
      const pathView = window.location.pathname.replace(/^\//, '')
      if (pathView === 'notifications' || pathView.startsWith('notifications/')) {
        return pathView
      }
      const storedView = sessionStorage.getItem('dashboardView')
      if (storedView) {
        sessionStorage.removeItem('dashboardView') // Clear after reading
        if (!initialView || initialView === 'dashboard') {
          return storedView
        }
      }
    }
    return initialView || 'dashboard'
  }

  const [currentView, setCurrentView] = useState(getInitialView)

  // Sync state with URL params when they change
  useEffect(() => {
    if (pathname === '/notifications' || pathname?.startsWith('/notifications/')) {
      setCurrentView(pathname.replace(/^\//, ''))
      return
    }
    if (pathname === '/settings/notifications/sms-activity') {
      setCurrentView('notifications/sms-activity')
      return
    }
    if (pathname === '/settings/notifications/email-activity') {
      setCurrentView('notifications/email-activity')
      return
    }
    if (initialView) {
      setCurrentView(initialView)
    }
  }, [initialView, pathname])

  // Seed the selected organization from the URL (deep link / refresh / back-forward)
  // so organization detail/edit views load the right record without relying only
  // on in-memory React state. Detail components read sessionStorage('selectedOrgId').
  useEffect(() => {
    if (initialOrgId && typeof window !== 'undefined') {
      sessionStorage.setItem('selectedOrgId', initialOrgId)
    }
  }, [initialOrgId])

  // Seed product / order ids from Supply Chain deep links the same way.
  useEffect(() => {
    if (initialProductId && typeof window !== 'undefined') {
      sessionStorage.setItem('selectedProductId', initialProductId)
    }
  }, [initialProductId])

  useEffect(() => {
    if (initialOrderId && typeof window !== 'undefined') {
      sessionStorage.setItem('viewOrderId', initialOrderId)
    }
  }, [initialOrderId])

  const handleViewChange = (view: string) => {
    // Don't clear org selection for edit/view flows
    if (view !== 'edit-organization' && view !== 'edit-organization-hq' && view !== 'view-organization') {
      sessionStorage.removeItem('selectedOrgId')
      sessionStorage.removeItem('selectedOrgType')
    }
    // Don't clear product selection for product edit/view flows
    if (view !== 'edit-product' && view !== 'view-product') {
      sessionStorage.removeItem('selectedProductId')
    }

    // Clear order selection when leaving order views
    if (view !== 'view-order' && view !== 'track-order') {
      sessionStorage.removeItem('viewOrderId')
    }

    if (view === 'point-catalog') {
      router.push('/engagement/catalog')
      return
    }

    if (view === 'point-catalog-admin' || view === 'point-catalog-admin-list') {
      router.push('/engagement/catalog/admin')
      return
    }

    if (view === 'point-catalog-admin-new') {
      router.push('/engagement/catalog/admin/new')
      return
    }

    // ── Redirect old accounting URLs to Finance module ────────────
    if (view === 'accounting' || view === 'settings-accounting') {
      setCurrentView(view)
      router.push('/finance')
      return
    }

    // ── Redirect Customer & Growth breadcrumb to its landing page ──
    if (view === 'customer-growth') {
      setCurrentView(view)
      router.push('/customer-growth')
      return
    }

    // ── Redirect Supply Chain to its landing page ──
    if (view === 'supply-chain') {
      setCurrentView(view)
      router.push('/supply-chain')
      return
    }

    // ── Redirect Notifications to its landing page ──
    if (view === 'notifications' || view === '/notifications') {
      setCurrentView('notifications')
      router.push('/notifications')
      return
    }

    const notificationView = view.startsWith('/') ? view.slice(1) : view
    if (notificationView.startsWith('notifications/')) {
      setCurrentView(notificationView)
      router.push(`/${notificationView}`)
      return
    }
    if (notificationView === 'settings/notifications/sms-activity') {
      setCurrentView('notifications/sms-activity')
      router.push('/notifications/sms-activity')
      return
    }
    if (notificationView === 'settings/notifications/email-activity') {
      setCurrentView('notifications/email-activity')
      router.push('/notifications/email-activity')
      return
    }

    const supplyChainPath = supplyChainViewToPath[view]
    if (supplyChainPath) {
      setCurrentView(view)
      router.push(`/supply-chain/${supplyChainPath}`)
      return
    }

    // ── Organizations: push real URLs so refresh / back-forward resolve the
    //    correct view and organization id (not only in-memory state). ──
    //    edit-organization-hq is intentionally excluded: HQ self-edit renders
    //    Settings and keeps its existing in-memory behaviour.
    if (view === 'organizations' || view === 'add-organization' || view === 'view-organization' || view === 'edit-organization') {
      const orgId = typeof window !== 'undefined' ? sessionStorage.getItem('selectedOrgId') : null
      const orgPath = supplyChainOrganizationPath(view, orgId)
      if (orgPath) {
        setCurrentView(view)
        router.push(`/supply-chain/${orgPath}`)
        return
      }
    }

    // ── Products detail/edit (id in URL + sessionStorage) ──
    if (view === 'view-product' || view === 'edit-product' || view === 'add-product') {
      const productId = typeof window !== 'undefined' ? sessionStorage.getItem('selectedProductId') : null
      const productPath = supplyChainProductPath(view, productId)
      if (productPath) {
        setCurrentView(view)
        router.push(`/supply-chain/${productPath}`)
        return
      }
    }

    // ── Orders detail/track (id in URL + sessionStorage) ──
    if (view === 'view-order' || view === 'track-order' || view === 'create-order') {
      const orderId = typeof window !== 'undefined' ? sessionStorage.getItem('viewOrderId') : null
      const orderPath = supplyChainOrderPath(view, orderId)
      if (orderPath) {
        setCurrentView(view)
        router.push(`/supply-chain/${orderPath}`)
        return
      }
    }

    // ── Shell secondary pages ──
    if (view === 'reporting') {
      setCurrentView(view)
      router.push('/reporting')
      return
    }
    if (view === 'my-profile') {
      setCurrentView(view)
      router.push('/my-profile')
      return
    }
    if (view === 'users') {
      setCurrentView(view)
      router.push('/users')
      return
    }
    if (view === 'security-access') {
      setCurrentView(view)
      router.push('/security-access')
      return
    }
    if (view === 'user-profile') {
      const targetId =
        (typeof window !== 'undefined' ? sessionStorage.getItem('selectedUserId') : null) ||
        initialTargetId ||
        userProfile.id
      setCurrentView(view)
      router.push(`/users/${targetId}`)
      return
    }

    // ── Customer & Growth module deep links (RoadTour / CRM / Marketing / …) ──
    // Mirror Supply Chain: same views and components; only the URL is synced so
    // refresh + back/forward keep the active subpage. No UI/design changes.
    const moduleHref =
      roadtourHrefForView(view) ||
      crmHrefForView(view) ||
      marketingHrefForView(view) ||
      loyaltyHrefForView(view) ||
      catalogHrefForView(view) ||
      ecommerceHrefForView(view)

    if (moduleHref) {
      setCurrentView(view)
      router.push(moduleHref)
      return
    }

    setCurrentView(view)
  }

  const renderCurrentView = () => {
    const viewId = String(currentView || '').replace(/^\//, '')
    if (
      viewId !== 'supply-chain' &&
      isSupplyChainViewId(viewId) &&
      !canAccessSupplyChainView(viewId, orgTypeCode, roleLevel)
    ) {
      return (
        <div className="p-8">
          <h2 className="text-xl font-semibold text-gray-900">Unauthorized</h2>
          <p className="mt-2 text-sm text-gray-600">
            You do not have permission to view this Supply Chain page.
          </p>
        </div>
      )
    }

    // Switched on the slash-normalized id so SerApp's routes resolve, and legacy
    // RoadTour Analytics view ids still resolve to the report that replaced
    // them, so old deep links never render a blank page.
    switch (isRoadtourViewId(viewId) ? resolveRoadtourViewId(viewId) : viewId) {
      case 'products':
        return <ProductsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'view-product':
        return <ViewProductDetails userProfile={userProfile} onViewChange={handleViewChange} />
      case 'edit-product':
        return <EditProductView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'product-management':
        return <ProductManagement userProfile={userProfile} onViewChange={handleViewChange} />
      case 'add-product':
        return <AddProductView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'orders':
        return <OrdersView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'create-order':
        return <CreateOrderView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'view-order':
        return <ViewOrderDetailsView userProfile={userProfile} onViewChange={handleViewChange} orderId={initialOrderId} />
      case 'track-order':
        return <TrackOrderView userProfile={userProfile} onViewChange={handleViewChange} />

      // QR Tracking Views
      case 'qr-batches':
        return <QRBatchesView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'manufacturer-scan-2':
        return <ManufacturerScanView2 userProfile={userProfile} />
      case 'warehouse-receive-2':
        return <WarehouseReceiveView2 userProfile={userProfile} />
      case 'warehouse-ship-v2':
        return <WarehouseShipV2 userProfile={userProfile} onViewChange={handleViewChange} />
      case 'distributor-order':
        return <DistributorOrderView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'distributor-incentive':
        return <DistributorIncentiveView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'shop-order':
        return <ShopOrderView userProfile={userProfile} onViewChange={handleViewChange} />


      // Consumer Engagement Views
      case 'journey-builder':
        return <JourneyBuilderV2 userProfile={userProfile} />
      case 'marketing':
        return <MarketingPage />
      case 'landing-pages':
        return <LandingPagesAdminView />
      case 'support-inbox':
        return <AdminSupportInboxV2 />
      case 'lucky-draw':
        return (
          <LuckyDrawView
            userProfile={userProfile}
            onViewChange={handleViewChange}
            initialOrderId={initialOrderId}
          />
        )
      case 'scratch-card-game':
        return <ScratchCardGameView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'redeem-gift-management':
        return (
          <RedeemGiftManagementView
            userProfile={userProfile}
            onViewChange={handleViewChange}
            initialOrderId={initialOrderId}
          />
        )
      case 'consumer-activations':
        return <ConsumerActivationsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'product-catalog':
        return <ProductCatalogView userProfile={userProfile} onViewChange={handleViewChange} />

      case 'manufacturer-quality-issues':
        return <QualityIssuesView userProfile={userProfile} />

      // Quality & Returns → Return Product module
      case 'return-product':
        return <ReturnProductView userProfile={userProfile} />
      case 'return-settings':
        return <ReturnSettingsView userProfile={userProfile} />
      case 'return-reporting':
        return <ReturnReportingView userProfile={userProfile} onViewChange={handleViewChange} />

      case 'supply-chain':
        return <SupplyChainLandingView userName={userProfile.full_name} onViewChange={handleSupplyChainNavigate} orgTypeCode={orgTypeCode} roleLevel={roleLevel} bannerImageUrl={moduleBannerUrls.supply} />

      case 'loyalty':
        return <LoyaltyLandingView userName={userProfile.full_name} onViewChange={handleViewChange} hideHeroBanner />

      case 'crm':
        return <CrmLandingView userName={userProfile.full_name} onViewChange={handleViewChange} hideHeroBanner />

      case 'mktg':
        return <MarketingLandingView userName={userProfile.full_name} onViewChange={handleViewChange} hideHeroBanner />

      case 'catalog':
        return <CatalogLandingView userName={userProfile.full_name} onViewChange={handleViewChange} hideHeroBanner />

      case 'customer-growth':
        return <CustomerGrowthLandingView userName={userProfile.full_name} onViewChange={handleViewChange} bannerImageUrl={moduleBannerUrls.customer} />

      case 'roadtour':
        return <RoadtourLandingView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-campaigns':
        return <RoadtourCampaignsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-qr':
        return <RoadtourQrManagementView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-surveys':
        return <RoadtourSurveyHubView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-visits':
        return <RoadtourVisitsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-monthly-overview':
        return <MonthlyOverviewView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-am-performance':
        return <AmPerformanceView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-shop-performance':
        return <ShopPerformanceView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-shop-follow-up':
        return <ShopFollowUpView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-shop-drilldown':
        return <ShopDrilldownView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-monthly-kpi-report':
        return <MonthlyKpiPerformanceReportView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-whatsapp':
        return <RoadtourWhatsAppMonitoringView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-kpi-settings':
        return <RoadtourKpiSettingsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'roadtour-settings':
        return <RoadtourSettingsView userProfile={userProfile} />

      case 'hero-banners':
      case 'store-banner-manager':
        return <HeroBannersUnifiedView userProfile={userProfile} onViewChange={handleViewChange} initialTab="landing" />
      case 'login-hero-banner':
        return <HeroBannersUnifiedView userProfile={userProfile} onViewChange={handleViewChange} initialTab="login" />
      case 'store-orders':
        return <StoreOrdersView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'ecommerce/payment-gateway':
        return (
          <PaymentGatewaySettingsView
            organizationId={userProfile.organizations?.id}
            canEdit={userProfile.roles?.role_level <= 20}
          />
        )

      case 'inventory':
      case 'inventory-list':
        return <InventoryView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'inventory-settings':
        return <InventorySettingsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'add-stock':
        return <AddStockView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'stock-adjustment':
        return <StockAdjustmentView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'stock-transfer':
        return <StockTransferView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'stock-movements':
        return <StockMovementReportView userProfile={userProfile} onViewChange={handleViewChange} initialSearch={initialTargetId} />
      case 'migration':
        return <MigrationView userProfile={userProfile} />
      case 'organizations':
        return <OrganizationsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'add-organization':
        return <AddOrganizationView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'edit-organization':
        // For non-HQ orgs, show dedicated edit page
        return <EditOrganizationView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'edit-organization-hq':
        // For HQ orgs, go to Settings
        return <SettingsView userProfile={userProfile} />
      case 'view-organization':
        // Navigate back to organizations view
        return <OrganizationsView userProfile={userProfile} onViewChange={handleViewChange} />
      case 'distributors':
        return <DistributorsView userProfile={userProfile} />
      case 'my-profile':
        return <MyProfileViewNew userProfile={userProfile} />
      case 'users':
        return <UsersView userProfile={userProfile} />
      case 'security-access':
        return <SecurityAccessView userProfile={userProfile} />
      case 'user-profile':
        return (
          <UserProfileWrapper
            targetUserId={initialTargetId || userProfile.id}
            currentUserProfile={userProfile}
            onBack={() => handleViewChange('users')}
          />
        )

      case 'reporting':
        return <ReportingView userProfile={userProfile} />

      // ── Settings Module Views ──────────────────────────────────
      case 'settings':
        return <SettingsLandingView userName={userProfile.full_name} roleLevel={userProfile.roles.role_level} bannerImageUrl={moduleBannerUrls.settings} />
      case 'settings/profile':
        return <SettingsView userProfile={userProfile} initialTab="profile" />
      case 'settings/organization':
        return <SettingsView userProfile={userProfile} initialTab="organization" />
      case 'settings/preferences':
        return <SettingsView userProfile={userProfile} initialTab="preferences" />
      case 'settings/preferences/document-template':
        return <DocumentTemplateTab userProfile={userProfile} />
      case 'settings/preferences/doc-sequence':
        return <DocSequenceTab userProfile={userProfile} />
      case 'notifications':
        return <NotificationsLandingView />
      case 'notifications/providers':
      case 'settings/notifications/providers':
        return <NotificationProvidersTab userProfile={userProfile} />
      case 'notifications/types':
      case 'settings/notifications/types':
        return <NotificationTypesTab userProfile={userProfile} />
      case 'notifications/whatsapp-activity-recovery':
      case 'settings/notifications/whatsapp-activity':
        return <NotificationMonitor initialChannel="whatsapp" />
      case 'notifications/sms-activity':
      case 'settings/notifications/sms-activity':
      case 'sms-activity':
        return <NotificationMonitor initialChannel="sms" />
      case 'notifications/email-activity':
      case 'settings/notifications/email-activity':
      case 'email-activity':
        return <NotificationMonitor initialChannel="email" />
      case 'settings/notifications':
        return <NotificationsLandingView />
      case 'settings/authorization':
        return <AuthorizationTab userProfile={userProfile} />
      case 'settings/ai':
        return (
          <AiProviderSettingsCard
            organizationId={userProfile.organizations.id}
            canEdit={userProfile.roles.role_level <= 20}
          />
        )
      case 'settings/ai/usage':
        return (
          <AiUsageDashboard
            organizationId={userProfile.organizations.id}
          />
        )
      case 'settings/danger-zone':
        return <DangerZoneTab userProfile={userProfile} />
      case 'settings/payment-gateway':
        return (
          <PaymentGatewaySettingsView
            organizationId={userProfile.organizations.id}
            canEdit={userProfile.roles.role_level <= 20}
          />
        )
      case 'hr-people':
        return (
          <HrPeopleView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr-org-chart':
        return <HrOrgChartView userProfile={userProfile} />
      case 'hr-departments':
        return <HrDepartmentsView userProfile={userProfile} />
      case 'hr-positions':
        return (
          <HrPositionsView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr-settings':
        return (
          <HrSettingsView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr/people/employees':
        return (
          <HrPeopleView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr/people/org-chart':
        return <HrOrgChartView userProfile={userProfile} />
      case 'hr/people/departments':
        return <HrDepartmentsView userProfile={userProfile} />
      case 'hr/people/positions':
        return (
          <HrPositionsView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr/attendance/clock-in-out':
        return <HrAttendanceClockView userProfile={userProfile} />
      case 'hr/attendance/public-holidays':
        return <HrPublicHolidaysView canEdit={canEditHr} />
      case 'hr/attendance/timesheets':
        return <HrAttendanceTimesheetsView userProfile={userProfile} />
      case 'hr/leave/types':
        return (
          <HrLeaveTypesView
            organizationId={userProfile.organizations.id}
            userId={userProfile.id}
          />
        )
      case 'hr/leave/requests':
        return (
          <HrLeaveRequestsView
            organizationId={userProfile.organizations.id}
            userId={userProfile.id}
          />
        )
      case 'hr/leave/approval-flow':
        return <HrLeaveApprovalFlowView />
      case 'hr/payroll/salary-structure':
        return <HrPayrollSalaryView userProfile={userProfile} />
      case 'hr/payroll/allowances-deductions':
        return <HrPayrollAllowancesView userProfile={userProfile} />
      case 'hr/payroll/payslips':
        return <HrPayrollPayslipsView userProfile={userProfile} />
      case 'hr/performance/kpis':
        return <HrKpiModuleView />
      case 'hr/performance/appraisals':
        return <HrPerformanceAppraisalsView />
      case 'hr/performance/reviews':
        return <HrPerformanceReviewsView />
      case 'hr/settings/departments':
        return <HrDepartmentsView userProfile={userProfile} />
      case 'hr/settings/positions':
        return (
          <HrPositionsView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr/settings/approval-rules':
        return <HrSettingsApprovalRulesView />
      case 'hr/settings/permissions':
        return <HrSettingsPermissionsView />
      case 'hr/settings/accounting':
        return (
          <HrAccountingView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
          />
        )
      case 'hr/settings/configuration':
        return (
          <HrConfigurationView
            organizationId={userProfile.organizations.id}
            canEdit={canEditHr}
            onNavigate={handleViewChange}
          />
        )
      case 'hr':
        return <HrLandingView userName={userProfile.full_name} bannerImageUrl={moduleBannerUrls.hr} />

      // ── Finance Module Views ──────────────────────────────────
      case 'finance':
        return <FinanceLandingView userName={userProfile.full_name} bannerImageUrl={moduleBannerUrls.finance} />
      case 'finance/gl/journals':
        return <GLJournalView userProfile={userProfile} />
      case 'finance/gl/pending-postings':
        return <PendingPostingsView userProfile={userProfile} />
      case 'finance/gl/chart-of-accounts':
        return <ChartOfAccountsTab userProfile={userProfile} />
      case 'finance/settings/default-accounts':
        return <DefaultAccountsSettings userProfile={userProfile} />
      case 'finance/settings/currency':
        return <FinanceCurrencySettingsView userProfile={userProfile} />
      case 'finance/settings/fiscal-year':
        return (
          <AccountingTab userProfile={userProfile} />
        )
      case 'finance/settings/posting-rules':
        return (
          <PostingRulesSettings userProfile={userProfile} />
        )
      case 'finance/settings/permissions':
        return (
          <FinancePermissionsSettings userProfile={userProfile} />
        )
      case 'finance/settings/configuration':
        return (
          <FinanceConfigurationView
            organizationId={userProfile.organizations.id}
            canEdit={canEditFinance}
            onNavigate={handleViewChange}
          />
        )
      case 'finance/status':
        return <AccountingTab userProfile={userProfile} />
      // AR placeholders
      case 'finance/ar/invoices':
        return <ARInvoicesView userProfile={userProfile} />
      case 'finance/ar/receipts':
        return <ARReceiptsView userProfile={userProfile} />
      case 'finance/ar/aging':
        return <ARAgingView userProfile={userProfile} />
      // AP placeholders
      case 'finance/ap/bills':
        return <APBillsView userProfile={userProfile} />
      case 'finance/ap/payments':
        return <APPaymentsView userProfile={userProfile} />
      case 'finance/ap/aging':
        return <APAgingView userProfile={userProfile} />
      // Cash & Banking
      case 'finance/cash/bank-accounts':
        return <BankAccountsView userProfile={userProfile} />
      case 'finance/cash/statements':
        return <BankStatementsView userProfile={userProfile} />
      case 'finance/cash/reconciliation':
        return <BankReconciliationView userProfile={userProfile} />
      case 'finance/cash/cashflow':
        return <CashFlowView userProfile={userProfile} />
      // Reports placeholders
      case 'finance/reports/trial-balance':
        return <TrialBalanceView userProfile={userProfile} />
      case 'finance/reports/profit-loss':
        return <ProfitLossView userProfile={userProfile} />
      case 'finance/reports/balance-sheet':
        return <BalanceSheetView userProfile={userProfile} />
      case 'finance/reports/gl-detail':
        return <GLDetailView userProfile={userProfile} />
      case 'finance/reports/cashflow':
        return <CashFlowView userProfile={userProfile} />

      default:
        return <DashboardOverview userProfile={userProfile} onViewChange={handleViewChange} bannerImageUrl={moduleBannerUrls.dashboard} />
    }
  }

  const isHrView = currentView === 'hr' || currentView.startsWith('hr/') || currentView.startsWith('hr-')
  const isFinanceView = currentView === 'finance' || currentView.startsWith('finance/')
  const isSettingsView = currentView === 'settings' || currentView.startsWith('settings/')
  const isNotificationsView = currentView === 'notifications' || currentView.startsWith('notifications/')
  const isSupplyChainView = isSupplyChainViewId(currentView)
  const isLoyaltyView = isLoyaltyViewId(currentView)
  const isCrmView = isCrmViewId(currentView)
  const isMarketingView = isMarketingViewId(currentView)
  const isCatalogView = isCatalogViewId(currentView)
  const isCustomerGrowthView = isCustomerGrowthViewId(currentView)
  const isRoadtourView = isRoadtourViewId(currentView)
  // Show Customer & Growth domain top-nav on ALL CG views (landing + child modules + sub-views)
  const showCustomerGrowthTopNav = isCustomerGrowthView
  const hasRenderedTopNav =
    isHrView ||
    isFinanceView ||
    isSettingsView ||
    isNotificationsView ||
    isSupplyChainView ||
    isLoyaltyView ||
    isCrmView ||
    isMarketingView ||
    isCatalogView ||
    isRoadtourView ||
    showCustomerGrowthTopNav

  const handleHrNavigate = (href: string) => {
    router.push(href)
  }

  const handleFinanceNavigate = (href: string) => {
    router.push(href)
  }

  const handleSettingsNavigate = (href: string) => {
    router.push(href)
  }

  const handleSupplyChainNavigate = (viewId: string) => {
    if (!canAccessSupplyChainView(viewId, orgTypeCode, roleLevel)) return
    handleViewChange(viewId)
  }

  const handleLoyaltyNavigate = (viewId: string) => {
    handleViewChange(viewId)
  }

  const handleCrmNavigate = (viewId: string) => {
    handleViewChange(viewId)
  }

  const handleMarketingNavigate = (viewId: string) => {
    handleViewChange(viewId)
  }

  const handleCatalogNavigate = (viewId: string) => {
    handleViewChange(viewId)
  }

  const handleCustomerGrowthNavigate = (viewId: string) => {
    handleViewChange(viewId)
  }

  return (
    <div className="h-[100dvh] max-h-[100dvh] overflow-hidden bg-[var(--sera-paper,#f7f8fa)] flex sera-shell">
      {/* Mobile: w-0 so off-canvas drawer never steals flex width. Desktop unchanged. */}
      <div className="print:hidden w-0 min-w-0 overflow-visible shrink-0 lg:w-auto lg:sticky lg:top-0 lg:h-[100dvh] lg:self-start">
        <Sidebar
          userProfile={userProfile}
          currentView={currentView}
          onViewChange={handleViewChange}
          initialCollapsed={sidebarCollapsed}
          onCollapseChange={(c) => setSidebarCollapsed(c)}
        />
      </div>
      {/* Main Content - fills remaining space */}
      <div className="flex-1 w-full min-w-0 h-full min-h-0 flex flex-col overflow-hidden bg-[var(--sera-paper,#f7f8fa)]">
        <div className="sera-top-chrome print:hidden shrink-0">
        {/* HR Top Navigation — shown only on /hr/* routes */}
        {isHrView && (
          <HRTopNav currentView={currentView} onNavigate={handleHrNavigate} />
        )}
        {/* Finance Top Navigation — shown only on /finance/* routes */}
        {isFinanceView && (
          <FinanceTopNav currentView={currentView} onNavigate={handleFinanceNavigate} />
        )}
        {/* Settings Top Navigation — shown only on /settings/* routes */}
        {isSettingsView && (
          <SettingsTopNav currentView={currentView} onNavigate={handleSettingsNavigate} roleLevel={userProfile.roles.role_level} />
        )}
        {isNotificationsView && (
          <NotificationsTopNav currentView={currentView} onNavigate={handleSettingsNavigate} />
        )}
        {/* Supply Chain Top Navigation — shown on SC views */}
        {isSupplyChainView && (
          <SupplyChainTopNav currentView={currentView} onNavigate={handleSupplyChainNavigate} orgTypeCode={orgTypeCode} roleLevel={roleLevel} />
        )}
        {/* Customer & Growth Domain Top Navigation — shown on ALL CG child views */}
        {showCustomerGrowthTopNav && (
          <CustomerGrowthTopNav currentView={currentView} onNavigate={handleCustomerGrowthNavigate} />
        )}
        {/* Child module top navs — shown BELOW the domain nav for within-module navigation */}
        {isCrmView && (
          <CrmTopNav currentView={currentView} onNavigate={handleCrmNavigate} />
        )}
        {isMarketingView && (
          <MarketingTopNav currentView={currentView} onNavigate={handleMarketingNavigate} />
        )}
        {isLoyaltyView && (
          <LoyaltyTopNav currentView={currentView} onNavigate={handleLoyaltyNavigate} />
        )}
        {isCatalogView && (
          <CatalogTopNav currentView={currentView} onNavigate={handleCatalogNavigate} />
        )}
        {isRoadtourView && (
          <RoadtourTopNav currentView={currentView} onNavigate={handleViewChange} />
        )}
        {!hasRenderedTopNav && (
          <GlobalPageChrome
            currentView={currentView}
            orgName={userProfile.organizations?.org_name}
          />
        )}
        </div>
        <main className="sera-main sera-main__scroll flex-1 min-h-0 overflow-y-auto overscroll-contain print:p-0 print:pt-0 print:overflow-visible print:h-auto">
          {children ?? renderCurrentView()}
        </main>
        {/* HR AI Assistant – floating button + chat drawer */}
        {isHrView && <HrAiAssistant />}
        {/* Finance AI Assistant */}
        {isFinanceView && <ModuleAiAssistant config={financeAssistantConfig} />}
        {/* Supply Chain AI Assistant */}
        {isSupplyChainView && <ModuleAiAssistant config={supplyChainAssistantConfig} />}
        {/* Customer & Growth AI Assistant */}
        {isCustomerGrowthView && <ModuleAiAssistant config={customerGrowthAssistantConfig} />}
      </div>
    </div>
  )
}
