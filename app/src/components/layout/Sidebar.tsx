"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/app/actions/auth";
import { filterMenuItems, type MenuItem } from "@/lib/menu-access";
import { usePermissions } from "@/hooks/usePermissions";
import { getAvatarSrc, cn } from "@/lib/utils";
import {
  Package,
  BarChart3,
  Bell,
  Building2,
  Truck,
  MessageSquare,
  Users,
  FileText,
  Settings as SettingsIcon,
  LogOut,
  User,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Store,
  ChevronDown,
  ChevronRight,
  QrCode,
  Scan,
  Gift,
  Trophy,
  ShieldCheck,
  Warehouse,
  Factory,
  BookOpen,
  ShoppingCart,
  Inbox,
  Plus,
  TrendingUp,
  ListTree,
  Database,
  Calculator,
  Receipt,
  Briefcase,
  UsersRound,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useTranslation } from "@/lib/i18n/LanguageProvider";
import { isSupplyChainViewId } from "@/modules/supply-chain/supplyChainNav";
import { isCustomerGrowthViewId } from "@/modules/customer-growth/customerGrowthNav";

interface SidebarProps {
  userProfile: any;
  currentView: string;
  onViewChange: (view: string) => void;
  onCollapseChange?: (collapsed: boolean) => void;
  initialCollapsed?: boolean;
}

// Main navigation menu items with access control
// Main navigation menu items with access control
const navigationItems: MenuItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: BarChart3,
    description: "Overview and analytics",
    // Accessible to all users
  },
  {
    id: "reporting",
    label: "Reporting",
    icon: TrendingUp,
    description: "Executive reports & insights",
    access: {
      allowedOrgTypes: ["HQ", "DIST", "WH"], // Removed MFG/MANU
      maxRoleLevel: 40, // Managers and above
    },
  },
  {
    id: "supply-chain",
    label: "Supply Chain",
    icon: Truck,
    description: "Products, orders, tracking & inventory",
    // Supply Chain submenu moved to Supply Chain top-nav bar (src/modules/supply-chain/supplyChainNav.ts)
    // Sidebar now shows Supply Chain as a single module entry → navigates to /supply-chain
  },
  {
    id: "customer-growth",
    label: "Customer & Growth",
    icon: UsersRound,
    description: "CRM, marketing, loyalty & product catalog",
    access: {
      allowedOrgTypes: ["HQ", "DIST", "WH", "SHOP"],
    },
    // Submenu moved to Customer & Growth top-nav bar (src/modules/customer-growth/customerGrowthNav.ts)
    // Sidebar now shows Customer & Growth as a single module entry → navigates to /customer-growth
  },

  {
    id: "hr",
    label: "HR",
    icon: Briefcase,
    description: "People & organization structure",
    access: {
      allowedOrgTypes: ["HQ", "DIST", "WH", "SHOP"],
      requiredPermissionsAny: ["view_users", "view_settings"],
      maxRoleLevel: 60,
    },
    // HR submenu moved to HR top-nav bar (src/modules/hr/hrNav.ts)
    // Sidebar now shows HR as a single module entry → navigates to /hr
  },

  {
    id: "finance",
    label: "Finance",
    icon: Calculator,
    description: "Finance & Accounting",
    access: {
      allowedOrgTypes: ["HQ", "DIST", "WH"],
      maxRoleLevel: 40,
    },
    // Finance submenu moved to Finance top-nav bar (src/modules/finance/financeNav.ts)
    // Sidebar now shows Finance as a single module entry → navigates to /finance
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    description: "Operational notification monitoring",
    access: {
      allowedOrgTypes: ["HQ"],
      maxRoleLevel: 40,
    },
  },
];

const secondaryItems: MenuItem[] = [
  {
    id: "my-profile",
    label: "My Profile",
    icon: User,
    description: "Personal profile and preferences",
    // Accessible to all authenticated users (replaces User Management for non-admins)
  },
  {
    id: "users",
    label: "User Management",
    icon: Users,
    description: "User management",
    access: {
      allowedOrgTypes: ["HQ", "DIST", "WH", "SHOP"],
      requiredPermission: "view_users",
    },
  },

  {
    id: "security-access",
    label: "Security & Access",
    icon: ShieldCheck,
    description: "Enterprise roles, permissions, scopes, and diagnostics",
    access: {
      allowedOrgTypes: ["HQ"],
      requiredPermission: "manage_authorization",
    },
  },

  {
    id: "settings",
    label: "Settings",
    icon: SettingsIcon,
    description: "System settings",
    access: {
      // Only HQ can access settings
      // Restrict to Level 40 and below (higher privilege)
      allowedOrgTypes: ["HQ"],
      maxRoleLevel: 40,
    },
  },
];

interface SidebarNavItemProps {
  icon: any;
  label: string;
  isActive?: boolean;
  hasChildren?: boolean;
  isOpen?: boolean;
  onClick?: () => void;
  isCollapsed?: boolean;
  className?: string;
}

const SidebarNavItem = ({
  icon: Icon,
  label,
  isActive,
  hasChildren,
  isOpen,
  onClick,
  isCollapsed,
  className,
}: SidebarNavItemProps) => {
  return (
    <button
      onClick={onClick}
      // Leaf items navigate away; pages with unsaved edits can guard on this.
      data-nav-href={hasChildren ? undefined : label}
      className={cn(
        "sera-sidebar__nav-btn select-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40",
        isActive && "is-active",
        className,
      )}
      title={isCollapsed ? label : undefined}
    >
      <Icon
        className={cn("sera-sidebar__nav-icon w-[18px] h-[18px] flex-shrink-0")}
        strokeWidth={1.5}
      />
      {!isCollapsed && (
        <>
          <span className="flex-1 text-left leading-none">{label}</span>
          {hasChildren && (
            <ChevronRight
              className={cn(
                "h-4 w-4 text-gray-300 ml-auto transition-transform duration-200",
                isOpen && "rotate-90 text-[var(--sera-orange)]",
              )}
              strokeWidth={1.5}
            />
          )}
        </>
      )}
    </button>
  );
};

export default function Sidebar({
  userProfile,
  currentView,
  onViewChange,
  onCollapseChange,
  initialCollapsed,
}: SidebarProps) {
  const {
    hasPermission,
    loading: permissionsLoading,
    permissions,
  } = usePermissions(
    userProfile?.roles?.role_level,
    userProfile?.role_code,
    userProfile?.department_id,
  );
  const { t } = useTranslation();

  // Translation map for sidebar navigation labels
  const labelMap: Record<string, string> = {
    Dashboard: t("sidebar.dashboard"),
    Reporting: t("sidebar.reporting"),
    "Supply Chain": t("sidebar.supplyChain"),
    "Customer & Growth": t("sidebar.customerGrowth"),
    HR: t("sidebar.hr"),
    Finance: t("sidebar.finance"),
    Notifications: t("sidebar.notifications"),
    "My Profile": t("sidebar.myProfile"),
    "User Management": t("sidebar.userManagement"),
    "Security & Access": "Security & Access",
    Settings: t("sidebar.settings"),
  };
  const tLabel = (label: string) => labelMap[label] || label;
  const [isCollapsed, setIsCollapsedRaw] = useState(() => {
    if (typeof initialCollapsed === "boolean") return initialCollapsed;
    if (typeof window !== "undefined") {
      return localStorage.getItem("ui.sidebarCollapsed") === "true";
    }
    return false;
  });

  const setIsCollapsed = (v: boolean | ((prev: boolean) => boolean)) => {
    setIsCollapsedRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      if (typeof window !== "undefined")
        localStorage.setItem("ui.sidebarCollapsed", String(next));
      onCollapseChange?.(next);
      return next;
    });
  };
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  /** Desktop collapse must not shrink the mobile drawer to an icon rail */
  const displayCollapsed = isCollapsed && !isMobileMenuOpen;
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const [expandedNestedMenu, setExpandedNestedMenu] = useState<string | null>(
    null,
  );
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [qrTrackingVisibility, setQrTrackingVisibility] = useState({
    manufacturer: { scan: true, scan2: true },
    warehouse: { receive: true, receive2: true, ship: true },
  });
  const router = useRouter();
  const supabase = createClient();

  const resolveHrPath = (id: string) => {
    if (id === "hr") return "/hr";
    if (id.startsWith("hr/")) return `/${id}`;
    if (id.startsWith("hr-")) return `/hr/${id.replace("hr-", "")}`;
    return null;
  };

  const resolveFinancePath = (id: string) => {
    if (id === "finance") return "/finance";
    if (id.startsWith("finance/")) return `/${id}`;
    return null;
  };

  const resolveSettingsPath = (id: string) => {
    if (id === "settings") return "/settings";
    if (id.startsWith("settings/")) return `/${id}`;
    return null;
  };

  const resolveSecurityAccessPath = (id: string) =>
    id === "security-access" ? "/security-access" : null;

  const resolveSupplyChainPath = (id: string) => {
    if (id === "supply-chain") return "/supply-chain";
    return null;
  };

  const resolveCustomerGrowthPath = (id: string) => {
    if (id === "customer-growth") return "/customer-growth";
    return null;
  };

  const resolveNotificationsPath = (id: string) => {
    if (id === "notifications") return "/notifications";
    if (id.startsWith("notifications/")) return `/${id}`;
    return null;
  };

  /** Resolve module-level navigation paths (HR, Finance, Settings, Supply Chain, Customer Growth, etc.) */
  const resolveModulePath = (id: string) => {
    return (
      resolveHrPath(id) ||
      resolveFinancePath(id) ||
      resolveSettingsPath(id) ||
      resolveSecurityAccessPath(id) ||
      resolveSupplyChainPath(id) ||
      resolveCustomerGrowthPath(id) ||
      resolveNotificationsPath(id)
    );
  };

  // Load org settings (QR tracking visibility + legacy prefs)
  useEffect(() => {
    const loadOrgSettings = async () => {
      if (!userProfile?.organization_id) return;

      try {
        const { data, error } = await supabase
          .from("organizations")
          .select("settings, logo_url, updated_at")
          .eq("id", userProfile.organization_id)
          .single();

        if (!error && data) {
          let settings: Record<string, any> = {};

          // Handle case where settings is a string (JSON)
          if (typeof data.settings === "string") {
            try {
              settings = JSON.parse(data.settings);
            } catch (e) {
              console.error("Failed to parse settings JSON in Sidebar:", e);
              settings = {};
            }
          } else if (
            typeof data.settings === "object" &&
            data.settings !== null
          ) {
            settings = data.settings as Record<string, any>;
          }

          // Load QR Tracking visibility from system_preferences
          // We wrap this in a try-catch because if the migration hasn't run, this might fail
          let loadedFromPrefs = false;
          try {
            // The table lives in the `core` schema (same as SettingsView's
            // read/save path); the default `public` schema has no such table.
            const { data: prefs, error: prefsError } = (await (supabase as any)
              .schema("core")
              .from("system_preferences")
              .select("*")
              .eq("company_id", userProfile.organization_id)
              .eq("module", "qr_tracking")) as {
              data: any[] | null;
              error: any;
            };

            if (prefsError) {
              // Log warning but don't crash - likely migration missing
              console.warn(
                "System preferences load warning (using fallback):",
                prefsError,
              );
            } else if (prefs && prefs.length > 0) {
              setQrTrackingVisibility({
                manufacturer: {
                  scan:
                    prefs.find((p: any) => p.key === "manufacturer_scan")?.value
                      ?.visible ?? true,
                  scan2:
                    prefs.find((p: any) => p.key === "manufacturer_scan_2")
                      ?.value?.visible ?? true,
                },
                warehouse: {
                  receive:
                    prefs.find((p: any) => p.key === "warehouse_receive")?.value
                      ?.visible ?? true,
                  receive2:
                    prefs.find((p: any) => p.key === "warehouse_receive_2")
                      ?.value?.visible ?? true,
                  ship:
                    prefs.find((p: any) => p.key === "warehouse_ship")?.value
                      ?.visible ?? true,
                },
              });
              loadedFromPrefs = true;
            }
          } catch (err) {
            console.warn("System preferences fetch error:", err);
          }

          // Fallback to legacy settings if system preferences failed or returned no data
          if (!loadedFromPrefs && settings?.qr_tracking_visibility) {
            console.log(
              "Loading QR visibility from legacy settings:",
              settings.qr_tracking_visibility,
            );
            setQrTrackingVisibility((prev) => ({
              manufacturer: {
                ...prev.manufacturer,
                ...(settings.qr_tracking_visibility?.manufacturer || {}),
              },
              warehouse: {
                ...prev.warehouse,
                ...(settings.qr_tracking_visibility?.warehouse || {}),
              },
            }));
          }
        }
      } catch (error) {
        console.error("Failed to load organization settings:", error);
      }
    };

    loadOrgSettings();

    // Listen for settings updates
    const handleSettingsUpdate = () => {
      loadOrgSettings();
    };

    if (typeof window !== "undefined") {
      window.addEventListener("settingsUpdated", handleSettingsUpdate);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("settingsUpdated", handleSettingsUpdate);
      }
    };
  }, [supabase, userProfile.organization_id]);

  // Persist expanded menu state to session storage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (expandedMenu) {
        sessionStorage.setItem("sidebarExpandedMenu", expandedMenu);
      } else {
        sessionStorage.removeItem("sidebarExpandedMenu");
      }
    }
  }, [expandedMenu]);

  // Auto-expand parent menu when navigating to a submenu item (including nested)
  useEffect(() => {
    // Check for direct submenu match
    let parentMenu = navigationItems.find((item) =>
      item.submenu?.some((sub) => sub.id === currentView),
    );

    // Check for nested submenu match (by id or targetView)
    if (!parentMenu) {
      parentMenu = navigationItems.find((item) =>
        item.submenu?.some((sub: any) =>
          sub.nestedSubmenu?.some(
            (nested: any) =>
              nested.id === currentView || nested.targetView === currentView,
          ),
        ),
      );

      // Also expand the nested submenu
      if (parentMenu) {
        const nestedParent = parentMenu.submenu?.find((sub: any) =>
          sub.nestedSubmenu?.some(
            (nested: any) =>
              nested.id === currentView || nested.targetView === currentView,
          ),
        );
        if (nestedParent && expandedNestedMenu !== nestedParent.id) {
          setExpandedNestedMenu(nestedParent.id);
        }
      }
    }

    if (parentMenu && expandedMenu !== parentMenu.id) {
      setExpandedMenu(parentMenu.id);
    }
  }, [currentView]);

  // Filter menu items based on user role and organization
  // While permissions are loading, use a permissive checker (returns true for all)
  // so items appear immediately; once loaded, exact permissions apply.
  const permissiveCheck = useMemo(() => () => true, []);

  const filteredNavigationItems = useMemo(() => {
    const checker = permissionsLoading ? permissiveCheck : hasPermission;
    const items = filterMenuItems(navigationItems, userProfile, checker);
    return items;
  }, [
    userProfile,
    qrTrackingVisibility,
    hasPermission,
    permissionsLoading,
    permissions,
    permissiveCheck,
  ]);

  const filteredSecondaryItems = useMemo(() => {
    const checker = permissionsLoading ? permissiveCheck : hasPermission;
    const items = filterMenuItems(secondaryItems, userProfile, checker);
    return items;
  }, [
    userProfile,
    hasPermission,
    permissionsLoading,
    permissions,
    permissiveCheck,
  ]);

  const handleSignOut = async (e?: React.MouseEvent) => {
    // Prevent accidental clicks
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Confirm before logging out to prevent accidental logouts
    if (!confirm("Are you sure you want to sign out?")) {
      return;
    }

    setIsSigningOut(true);
    try {
      // Use server action to properly clear cookies and session
      await signOut();
    } catch (error) {
      console.error("Sign out error:", error);
      // Fallback: force redirect even if server action fails
      window.location.href = "/login";
    } finally {
      setIsSigningOut(false);
    }
  };

  // Helper function to get user initials from name or email
  const getInitials = (
    fullName: string | null | undefined,
    email: string | null | undefined,
  ): string => {
    if (fullName) {
      return fullName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    if (email) {
      return email.substring(0, 2).toUpperCase();
    }
    return "U";
  };

  return (
    <>
      {/* Mobile Menu Button - Fixed Top Left */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="sera-mobile-nav-toggle lg:hidden fixed top-3 left-3 z-50 p-2 bg-white text-[var(--sera-ink)] rounded-lg border border-[var(--sera-line)] shadow-sm hover:border-[var(--sera-orange)]/40 transition-colors"
        aria-label="Toggle menu"
        aria-expanded={isMobileMenuOpen}
      >
        {isMobileMenuOpen ? (
          <X className="h-5 w-5" />
        ) : (
          <Menu className="h-5 w-5" />
        )}
      </button>

      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        sera-sidebar relative flex flex-col transition-all duration-300
        fixed lg:static inset-y-0 left-0 z-40
        ${displayCollapsed ? "w-16" : "w-64 max-lg:max-w-[88vw]"}
        ${isMobileMenuOpen ? "translate-x-0 sera-sidebar--open" : "-translate-x-full lg:translate-x-0"}
      `}
      >
        {/* Header — compact brand mark */}
        <div
          className={`border-b border-[var(--sera-line)] shrink-0 ${displayCollapsed ? "px-2 py-2" : "px-3 py-2"}`}
        >
          <div
            className={`flex items-center ${displayCollapsed ? "justify-center" : "justify-center w-full"}`}
          >
            {!displayCollapsed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/brand/serapod-wordmark.png"
                alt="serapod"
                className="w-[68%] max-w-[140px] h-10 object-contain object-center"
              />
            ) : (
              <span
                className="font-display text-base font-bold tracking-tight text-[var(--sera-ink)] leading-none"
                aria-label="serapod"
              >
                s
              </span>
            )}
          </div>
        </div>

        {/* Collapse toggle — vertically centered on the outer edge */}
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="hidden lg:flex absolute top-1/2 -translate-y-1/2 -right-3 z-50
            h-8 w-8 items-center justify-center rounded-full
            bg-white border border-[var(--sera-line)] text-[var(--sera-muted)]
            shadow-sm hover:text-[var(--sera-ink)] hover:border-[var(--sera-orange)]/50
            transition-colors"
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>

        {/* Navigation — balanced: roomy items, secondary sits above footer */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <nav className="h-full min-h-full px-2.5 py-3 flex flex-col">
            {/* Main Navigation */}
            <div className="sera-sidebar__nav-main">
              {filteredNavigationItems.map((item: any) => {
                // Check if current view matches any submenu or nested submenu
                const isActive =
                  currentView === item.id ||
                  // HR module: highlight when on any HR sub-route
                  (item.id === "hr" && currentView.startsWith("hr/")) ||
                  // Finance module: highlight when on any Finance sub-route
                  (item.id === "finance" &&
                    currentView.startsWith("finance/")) ||
                  // Notifications module: highlight when on any Notifications sub-route
                  (item.id === "notifications" &&
                    currentView.startsWith("notifications/")) ||
                  // Settings module: highlight when on any Settings sub-route
                  (item.id === "settings" &&
                    currentView.startsWith("settings/")) ||
                  // Supply Chain module: highlight when on any SC child view
                  (item.id === "supply-chain" &&
                    isSupplyChainViewId(currentView)) ||
                  // Customer & Growth domain: highlight when on any child module view
                  (item.id === "customer-growth" &&
                    isCustomerGrowthViewId(currentView)) ||
                  item.submenu?.some(
                    (sub: any) =>
                      sub.id === currentView ||
                      sub.targetView === currentView ||
                      sub.nestedSubmenu?.some(
                        (nested: any) =>
                          nested.id === currentView ||
                          nested.targetView === currentView,
                      ),
                  );
                const isMenuOpen = expandedMenu === item.id;

                return (
                  <div key={item.id}>
                    <SidebarNavItem
                      icon={item.icon}
                      label={tLabel(item.label)}
                      isActive={isActive}
                      hasChildren={!!item.submenu}
                      isOpen={isMenuOpen}
                      isCollapsed={displayCollapsed}
                      onClick={() => {
                        if (item.submenu) {
                          setExpandedMenu(isMenuOpen ? null : item.id);
                        } else {
                          // onViewChange (handleViewChange) handles both
                          // setCurrentView and router.push for module-level
                          // pages, so we don't need a separate router.push here.
                          onViewChange(item.id);
                          setIsMobileMenuOpen(false);
                        }
                      }}
                    />

                    {/* Submenu */}
                    {item.submenu && isMenuOpen && !displayCollapsed && (
                      <div className="mt-1 space-y-0.5 ml-4 border-l border-[var(--sera-line)] pl-2">
                        {item.submenu.map((subitem: any) => {
                          const hasNestedSubmenu =
                            subitem.nestedSubmenu &&
                            subitem.nestedSubmenu.length > 0;
                          const isNestedMenuOpen =
                            expandedNestedMenu === subitem.id;

                          // Check if this submenu or any of its nested items are active
                          const isSubitemActive =
                            currentView === subitem.id ||
                            (hasNestedSubmenu &&
                              subitem.nestedSubmenu.some(
                                (nested: any) =>
                                  currentView === nested.id ||
                                  currentView === nested.targetView,
                              ));

                          return (
                            <div key={subitem.id}>
                              <SidebarNavItem
                                icon={subitem.icon}
                                label={subitem.label}
                                isActive={isSubitemActive}
                                hasChildren={hasNestedSubmenu}
                                isOpen={isNestedMenuOpen}
                                isCollapsed={displayCollapsed}
                                className="py-2 h-9"
                                onClick={() => {
                                  if (hasNestedSubmenu) {
                                    setExpandedNestedMenu(
                                      isNestedMenuOpen ? null : subitem.id,
                                    );
                                  } else {
                                    const modulePath = resolveModulePath(
                                      subitem.id,
                                    );
                                    if (modulePath) {
                                      router.push(modulePath);
                                      setIsMobileMenuOpen(false);
                                    } else {
                                      onViewChange(subitem.id);
                                      setIsMobileMenuOpen(false);
                                    }
                                  }
                                }}
                              />

                              {/* Nested Submenu */}
                              {hasNestedSubmenu && isNestedMenuOpen && (
                                <div className="mt-0.5 space-y-0.5 ml-4 border-l border-[var(--sera-line)] pl-2">
                                  {subitem.nestedSubmenu.map(
                                    (nestedItem: any) => {
                                      const targetView =
                                        nestedItem.targetView || nestedItem.id;
                                      const isNestedActive =
                                        currentView === nestedItem.id ||
                                        currentView === targetView;

                                      return (
                                        <SidebarNavItem
                                          key={nestedItem.id}
                                          icon={nestedItem.icon}
                                          label={nestedItem.label}
                                          isActive={isNestedActive}
                                          hasChildren={false}
                                          isCollapsed={displayCollapsed}
                                          className="py-2 h-9"
                                          onClick={() => {
                                            const modulePath =
                                              resolveModulePath(targetView);
                                            if (modulePath) {
                                              router.push(modulePath);
                                            } else {
                                              onViewChange(targetView);
                                            }
                                            setIsMobileMenuOpen(false);
                                          }}
                                        />
                                      );
                                    },
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Secondary Navigation — pinned near footer via margin-top:auto */}
            <div className="sera-sidebar__nav-secondary">
              {filteredSecondaryItems.map((item) => {
                const isActive = currentView === item.id;

                return (
                  <SidebarNavItem
                    key={item.id}
                    icon={item.icon}
                    label={tLabel(item.label)}
                    isActive={isActive}
                    isCollapsed={displayCollapsed}
                    onClick={() => {
                      onViewChange(item.id);
                      setIsMobileMenuOpen(false); // Close mobile menu on navigation
                    }}
                  />
                );
              })}
            </div>
          </nav>
        </div>

        {/* User Profile + Sign Out — pinned bottom */}
        <div className="shrink-0 bg-white border-t border-[var(--sera-line)]">
          {!displayCollapsed ? (
            <div className="p-3 pb-2">
              <div className="flex items-center gap-3 px-2.5 py-2">
                <Avatar className="h-9 w-9">
                  {userProfile?.avatar_url && (
                    <AvatarImage
                      src={
                        getAvatarSrc(userProfile.avatar_url)
                      }
                      alt={userProfile.full_name || "User"}
                    />
                  )}
                  <AvatarFallback className="bg-[var(--sera-orange)] text-white text-xs font-semibold">
                    {getInitials(userProfile?.full_name, userProfile?.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--sera-ink)] truncate">
                    {userProfile?.full_name || userProfile?.email || "User"}
                  </p>
                  <p className="text-xs text-[var(--sera-muted)] truncate">
                    {userProfile?.roles?.role_name || "Guest"} •{" "}
                    {userProfile?.organizations?.org_name || "No Org"}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex justify-center pt-3 pb-1">
              <Avatar className="h-8 w-8">
                {userProfile?.avatar_url && (
                  <AvatarImage
                    src={
                      getAvatarSrc(userProfile.avatar_url)
                    }
                    alt={userProfile.full_name || "User"}
                  />
                )}
                <AvatarFallback className="bg-[var(--sera-orange)] text-white text-[10px] font-semibold">
                  {getInitials(userProfile?.full_name, userProfile?.email)}
                </AvatarFallback>
              </Avatar>
            </div>
          )}

          <div className={`px-3 pb-3 ${displayCollapsed ? "pt-2" : "pt-0"}`}>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              title={t("common.signOut")}
              className={`
                w-full flex items-center gap-2.5 rounded-lg border
                border-red-200/80 bg-red-50 text-red-700
                hover:border-red-300 hover:bg-red-100 hover:text-red-800
                transition-colors disabled:opacity-50
                ${displayCollapsed ? "justify-center h-10 px-0" : "justify-start h-10 px-3"}
              `}
            >
              <LogOut className="h-4 w-4 flex-shrink-0" />
              {!displayCollapsed && (
                <span className="text-sm font-semibold">
                  {isSigningOut ? t("common.loading") : t("common.signOut")}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
