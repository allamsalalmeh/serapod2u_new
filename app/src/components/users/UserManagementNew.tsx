"use client";

import { useState, useEffect, useMemo } from "react";
import { getOrgTypeName } from "@/lib/utils/orgHierarchy";
import { useSupabaseAuth } from "@/lib/hooks/useSupabaseAuth";
import { useToast } from "@/components/ui/use-toast";
import {
  createUserWithAuth,
  setUserAccountStatus,
  updateUserWithAuth,
} from "@/lib/actions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Users,
  Search,
  Plus,
  Loader2,
  Edit,
  CheckCircle,
  XCircle,
  Trash2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Power,
  PauseCircle,
  PlayCircle,
  Save,
  ChevronLeft,
  ChevronRight,
  Circle,
  AlertTriangle,
  Shield,
  Building2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import UserDialogNew, { type EditAccessSubmission } from "./UserDialogNew";
import type { User as UserType, Role, Organization } from "@/types/user";
import { getAvatarSrc } from "@/lib/utils";
import { compressAvatar, formatFileSize } from "@/lib/utils/imageCompression";
import { samePhone } from "@/utils/phone";
import { SeraLoadingState } from "@/components/ui/SeraLoader";
import {
  buildOrgOptions,
  buildOrgTypeOptions,
  organizationsForType,
  reconcileOrgSelection,
  userMatchesOrgFilters,
} from "./userOrgFilters";
import { useSaCapability } from "@/hooks/useSaCapability";
import { useNavAccess } from "@/hooks/useNavAccess";

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500, 1000, -1] as const; // -1 represents "All"
const PROGRAM_FILTER_OPTIONS = [
  { value: "", label: "All Programs" },
  { value: "Cellera", label: "Cellera" },
  { value: "Ellbow", label: "Ellbow" },
  { value: "Cellera + Ellbow", label: "Cellera + Ellbow" },
  { value: "Not Enrolled", label: "Not Enrolled" },
] as const;

const formatRelativeTime = (dateString: string | null): string => {
  if (!dateString) return "Never";
  try {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  } catch {
    return "Unknown";
  }
};

const formatDateTime = (dateString: string | null): string => {
  if (!dateString) return "Never";
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return "Unknown";
  }
};

// Check if user is online (logged in within last 15 minutes)
const isUserOnline = (lastLoginAt: string | null): boolean => {
  if (!lastLoginAt) return false;
  try {
    const lastLogin = new Date(lastLoginAt);
    const now = new Date();
    const diffMinutes = (now.getTime() - lastLogin.getTime()) / (1000 * 60);
    return diffMinutes <= 15;
  } catch {
    return false;
  }
};

interface User {
  id: string;
  email: string;
  full_name: string | null;
  call_name?: string | null;
  phone: string | null;
  referral_phone: string | null;
  consumer_claim_confirmed_at: string | null;
  is_active: boolean;
  account_status?: string | null;
  is_verified: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  avatar_url: string | null;
  role_code: string;
  organization_id: string;
  loyalty_program_user_memberships?: Array<{
    status: string | null;
    participant_type: string | null;
    loyalty_programs?: { code: string | null; name: string | null } | Array<{ code: string | null; name: string | null }> | null;
  }>;
}

interface UserProfile {
  id: string;
  role_code: string;
  organization_id: string;
  roles: { role_level: number };
}

type MasterOrganization = Organization & {
  contact_name?: string | null;
  contact_title?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  address?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state_id?: string | null;
  district_id?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
  website?: string | null;
  hot_flavour_brands?: string | null;
  sells_serapod_flavour?: boolean | null;
  sells_sbox?: boolean | null;
  sells_sbox_special_edition?: boolean | null;
  is_active?: boolean | null;
  updated_at?: string | null;
};

type SortField =
  | "full_name"
  | "role_code"
  | "is_active"
  | "organization_id"
  | "created_at"
  | "referral_phone"
  | "last_login_at";
type SortDirection = "asc" | "desc";

const getUserDisplayName = (user: Pick<User, "call_name" | "full_name" | "email">): string => {
  return user.call_name?.trim() || user.full_name?.trim() || user.email || "No Name";
};

const getSingleRelation = <T,>(relation: T | T[] | null | undefined): T | null => {
  if (Array.isArray(relation)) return relation[0] ?? null;
  return relation ?? null;
};

const getProgramLabelFromMemberships = (
  memberships?: User["loyalty_program_user_memberships"],
): string => {
  const activeCodes = new Set(
    (memberships || [])
      .filter((membership) => (membership.status || "active") === "active")
      .map((membership) => getSingleRelation(membership.loyalty_programs)?.code)
      .filter((code): code is string => code === "cellera" || code === "ellbow"),
  );

  if (activeCodes.has("cellera") && activeCodes.has("ellbow")) return "Cellera + Ellbow";
  if (activeCodes.has("cellera")) return "Cellera";
  if (activeCodes.has("ellbow")) return "Ellbow";
  return "Not Enrolled";
};

const normalizeComparableField = (value: unknown, field?: string) => {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (field === "employment_status" && trimmed === "active") {
      return null;
    }

    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return value ?? null;
};

const hasMeaningfulUserChanges = (
  existingUser: User,
  userData: Partial<UserType> & Record<string, any>,
) => {
  const comparableFields = [
    "full_name",
    "call_name",
    "role_code",
    "organization_id",
    "shop_name",
    "address",
    "referral_phone",
    "bank_id",
    "bank_account_number",
    "bank_account_holder_name",
    "department_id",
    "manager_user_id",
    "position_id",
    "employment_type",
    "join_date",
    "employment_status",
  ] as const;

  for (const field of comparableFields) {
    if (normalizeComparableField(userData[field], field) !== normalizeComparableField((existingUser as any)[field], field)) {
      return true;
    }
  }

  if (Boolean(userData.is_active ?? true) !== Boolean(existingUser.is_active)) {
    return true;
  }

  if ('can_be_reference' in userData && Boolean(userData.can_be_reference) !== Boolean((existingUser as any).can_be_reference)) {
    return true;
  }

  const nextPhone = userData.phone || null;
  const currentPhone = existingUser.phone || null;
  if ((nextPhone || currentPhone) && !samePhone(nextPhone, currentPhone)) {
    return true;
  }

  return false;
};

export default function UserManagementNew({
  userProfile,
  editUserId,
  onEditClose,
  onEditUnavailable,
}: {
  userProfile: UserProfile;
  editUserId?: string;
  onEditClose?: () => void;
  onEditUnavailable?: () => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [orgFilter, setOrgFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [orgTypeFilter, setOrgTypeFilter] = useState("");
  const [programFilter, setProgramFilter] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationsLoaded, setOrganizationsLoaded] = useState(false);
  const [organizationsLoadFailed, setOrganizationsLoadFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  // Divider on the pinned Actions column only while table content is
  // actually scrolled underneath it; on wide screens it is just noise.
  const [usersTableEl, setUsersTableEl] = useState<HTMLTableElement | null>(null);
  const [actionsCoverContent, setActionsCoverContent] = useState(false);
  const [pageSize, setPageSize] = useState<number>(20);
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false);
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [selectedOrganization, setSelectedOrganization] = useState<MasterOrganization | null>(null);
  const [organizationForm, setOrganizationForm] = useState<Partial<MasterOrganization>>({});
  const [organizationDialogUser, setOrganizationDialogUser] = useState<User | null>(null);

  // Delete progress state
  const [deleteProgress, setDeleteProgress] = useState<{
    isDeleting: boolean;
    current: number;
    total: number;
    progress: number;
    success: number;
    errors: number;
    message: string;
  } | null>(null);

  const { isReady, supabase } = useSupabaseAuth();
  const { toast } = useToast();

  const resolveCurrentUserLevel = () => {
    const roleLevel = userProfile?.roles?.role_level;
    if (typeof roleLevel === "number") return roleLevel;
    const roleCode = userProfile?.role_code?.toUpperCase();
    if (roleCode === "SUPERADMIN" || roleCode === "SUPER" || roleCode === "SA") return 1;
    if (roleCode === "HQ_ADMIN" || roleCode === "HQ") return 10;
    if (roleCode === "POWER_USER" || roleCode === "POWER") return 20;
    return 999;
  };

  // Archive Identities (platform.identity.delete): the S&A answer once enforced,
  // the historical HQ Admin / Super Admin rule until then. The server decides
  // every removal for the target's organization regardless.
  const identityRemovalAllowed = useSaCapability("platform.identity.delete", resolveCurrentUserLevel() <= 10);
  const canManageUserDeletion = () => identityRemovalAllowed;

  const currentUserLevel = resolveCurrentUserLevel();
  // Root Access (server answer): the legacy role-level pre-checks below do not apply to a Root Administrator, whose
  // legacy role stays unchanged. Display only; the server and database decide every read and change.
  const rootAccess = useNavAccess().snapshot?.rootAccess === true;
  // A target "outranks" the viewer for the legacy pre-checks (lower role_level = higher privilege).
  const outranksViewer = (targetLevel: number, viewerLevel: number) => !rootAccess && targetLevel < viewerLevel;
  const canEditSelectedOrganization =
    currentUserLevel === 1 &&
    selectedOrganization?.org_type_code === "SHOP" &&
    organizationDialogUser?.organization_id === selectedOrganization?.id;

  useEffect(() => {
    if (isReady && !editUserId) {
      loadUsers();
      loadRoles();
      loadOrganizations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, rootAccess]);

  useEffect(() => {
    const scroller = usersTableEl?.parentElement;
    if (!scroller) return;
    const update = () =>
      setActionsCoverContent(
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
      );
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(scroller);
    observer?.observe(usersTableEl);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [usersTableEl]);

  useEffect(() => {
    if (!isReady || !editUserId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await supabase.from('users')
          .select('*, roles:role_code(role_name, role_level)')
          .eq('id', editUserId).single();
        const level = resolveCurrentUserLevel();
        if (error || !data || (!rootAccess && level > 20 && (
          (data.roles?.role_level || 999) < level ||
          (data.organization_id && data.organization_id !== userProfile.organization_id)
        ))) throw new Error('This user is unavailable or you do not have permission to access it.');
        await Promise.all([loadRoles(), loadOrganizations()]);
        if (!cancelled) {
          setEditingUser(data as User);
          setDialogOpen(true);
        }
      } catch {
        if (!cancelled) {
          toast({ title: 'Unable to open user', description: 'This user is unavailable or you do not have permission to access it. Please try again later.', variant: 'destructive' });
          onEditUnavailable?.();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, editUserId, rootAccess]);

  const loadUsers = async () => {
    if (editUserId) { onEditClose?.(); return; }
    if (!isReady) return;
    try {
      setLoading(true);

      // Get current user's role level - users can only see same level and below (higher numbers)
      const currentUserLevel = resolveCurrentUserLevel();
      // Super Admin and HQ Admin can see all users, others see filtered by level
      const isPowerUser = rootAccess || currentUserLevel <= 20;

      // Fetch all users using pagination to overcome Supabase 1000 row limit
      const allUsers: any[] = [];
      const PAGE_SIZE = 1000;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        let query = (supabase as any)
          .from("users")
          .select(
            `
            *,
            roles:role_code (
              role_name,
              role_level
            ),
            loyalty_program_user_memberships!loyalty_program_user_memberships_user_id_fkey (
              status,
              participant_type,
              loyalty_programs!loyalty_program_user_memberships_program_owner_fk (
                code,
                name
              )
            )
          `,
            { count: "exact" }
          )
          .order("created_at", { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);

        // Filter by organization for non-power users
        if (!isPowerUser) {
          // Allow users to see their own organization AND independent users (null organization)
          // This is important for HQ/Managers (Level 40) managing independent consumers (Level 50)
          query = query.or(`organization_id.eq.${userProfile.organization_id},organization_id.is.null`);
        }

        const { data, error, count } = await query;

        if (error) throw error;

        if (data && data.length > 0) {
          allUsers.push(...data);
          offset += PAGE_SIZE;
          // Check if we've fetched all records
          hasMore = count ? allUsers.length < count : data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }

      const data = allUsers;

      // Filter users based on role level visibility
      console.log(`[UserManagement] Current User Level: ${currentUserLevel}, isPowerUser: ${isPowerUser}`)
      console.log(`[UserManagement] Query URL params approximated:`, !isPowerUser ? `or=(organization_id.eq.${userProfile.organization_id},organization_id.is.null)` : 'ALL')

      const visibleUsers = (data || []).filter((u: any) => {
        const userRoleLevel = u.roles?.role_level || 999;

        // Debug visibility logic
        // if (u.email.includes('indep') || u.role_code === 'USER') {
        //   console.log(`Checking visibility for ${u.email}: Level ${userRoleLevel} vs My Level ${currentUserLevel}`)
        // }

        // Power users (level <= 20) can see all users
        if (isPowerUser) return true;
        // Others can only see users at same level or below (higher number)
        return userRoleLevel >= currentUserLevel;
      });

      console.log(
        "📊 Loaded users:",
        visibleUsers.length,
        "users (filtered from",
        data?.length,
        ") for level",
        currentUserLevel,
      );
      setUsers(visibleUsers as User[]);
    } catch (error) {
      console.error("Error loading users:", error);
      toast({
        title: "Load Failed",
        description: "Could not load users. Please refresh.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const { data, error } = await supabase
        .from("roles")
        .select("role_code, role_name, role_level")
        .eq("is_active", true)
        .order("role_level", { ascending: true });

      if (error) throw error;
      setRoles((data || []) as Role[]);
    } catch (error) {
      console.error("Error loading roles:", error);
      if (editUserId) throw error;
    }
  };

  const loadOrganizations = async () => {
    setOrganizationsLoadFailed(false);
    try {
      const { data, error } = await supabase
        .from("organizations")
        .select("id, org_name, org_code, org_type_code, branch")
        .eq("is_active", true)
        .order("org_name", { ascending: true });

      if (error) throw error;
      setOrganizations((data || []) as Organization[]);
      setOrganizationsLoaded(true);
    } catch (error) {
      console.error("Error loading organizations:", error);
      setOrganizationsLoadFailed(true);
      if (editUserId) throw error;
    }
  };

  const handleOrganizationFieldChange = (field: keyof MasterOrganization, value: any) => {
    setOrganizationForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleOpenOrganizationDialog = async (user: User, organization: Organization) => {
    setOrganizationDialogUser(user);
    setSelectedOrganization(null);
    setOrganizationForm({});
    setOrganizationDialogOpen(true);
    setOrganizationLoading(true);

    try {
      const { data, error } = await supabase
        .from("organizations")
        .select("*")
        .eq("id", organization.id)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Organization not found.");

      const org = data as MasterOrganization;
      setSelectedOrganization(org);
      setOrganizationForm(org);
    } catch (error) {
      console.error("Error loading organization:", error);
      toast({
        title: "Load Failed",
        description: error instanceof Error ? error.message : "Could not load organization master data.",
        variant: "destructive",
      });
      setOrganizationDialogOpen(false);
    } finally {
      setOrganizationLoading(false);
    }
  };

  const handleSaveOrganization = async () => {
    if (!selectedOrganization || !canEditSelectedOrganization) return;

    try {
      setOrganizationSaving(true);

      const updatePayload = {
        org_name: organizationForm.org_name?.trim() || selectedOrganization.org_name,
        branch: organizationForm.branch?.trim() || null,
        contact_name: organizationForm.contact_name?.trim() || null,
        contact_title: organizationForm.contact_title?.trim() || null,
        contact_phone: organizationForm.contact_phone?.trim() || null,
        contact_email: organizationForm.contact_email?.trim() || null,
        address: organizationForm.address?.trim() || null,
        address_line2: organizationForm.address_line2?.trim() || null,
        city: organizationForm.city?.trim() || null,
        postal_code: organizationForm.postal_code?.trim() || null,
        country_code: organizationForm.country_code?.trim() || null,
        website: organizationForm.website?.trim() || null,
        hot_flavour_brands: organizationForm.hot_flavour_brands?.trim() || null,
        sells_serapod_flavour: Boolean(organizationForm.sells_serapod_flavour),
        sells_sbox: Boolean(organizationForm.sells_sbox),
        sells_sbox_special_edition: Boolean(organizationForm.sells_sbox_special_edition),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await (supabase as any)
        .from("organizations")
        .update(updatePayload)
        .eq("id", selectedOrganization.id)
        .eq("org_type_code", "SHOP")
        .select("*")
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Organization update was not applied.");

      const updated = data as MasterOrganization;
      setSelectedOrganization(updated);
      setOrganizationForm(updated);
      setOrganizations((prev) =>
        prev.map((org) =>
          org.id === updated.id
            ? {
              ...org,
              org_name: updated.org_name,
              org_code: updated.org_code,
              org_type_code: updated.org_type_code,
              branch: updated.branch,
            }
            : org,
        ),
      );

      toast({
        title: "Organization Updated",
        description: `${updated.org_name} master data has been saved.`,
      });
    } catch (error) {
      console.error("Error saving organization:", error);
      toast({
        title: "Save Failed",
        description: error instanceof Error ? error.message : "Could not save organization master data.",
        variant: "destructive",
      });
    } finally {
      setOrganizationSaving(false);
    }
  };

  // Track latest QR activity per visible user so Last Activity reflects either
  // direct login or premium-template / QR usage, whichever is newer.
  const [lastScanMap, setLastScanMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!isReady || users.length === 0) {
      setLastScanMap(new Map());
      return;
    }

    const loadLastScans = async () => {
      try {
        const userIds = users.map((user) => user.id).filter(Boolean);

        if (userIds.length === 0) {
          setLastScanMap(new Map());
          return;
        }

        const chunkSize = 250;
        const chunks: string[][] = [];

        for (let index = 0; index < userIds.length; index += chunkSize) {
          chunks.push(userIds.slice(index, index + chunkSize));
        }

        const results = await Promise.all(
          chunks.map(async (chunk) => {
            const { data, error } = await supabase
              .from('consumer_qr_scans')
              .select('consumer_id, scanned_at')
              .in('consumer_id', chunk)
              .eq('is_manual_adjustment', false)
              .not('scanned_at', 'is', null)
              .order('scanned_at', { ascending: false });

            if (error) {
              return [];
            }

            return data || [];
          }),
        );

        const map = new Map<string, string>();
        results.flat().forEach((row: any) => {
          if (!row.consumer_id || !row.scanned_at) {
            return;
          }

          const existing = map.get(row.consumer_id);
          if (!existing || row.scanned_at > existing) {
            map.set(row.consumer_id, row.scanned_at);
          }
        });
        setLastScanMap(map);
      } catch {
        setLastScanMap(new Map());
      }
    };

    loadLastScans();
  }, [isReady, supabase, users]);

  const getLatestActivityAt = (user: User): string | null => {
    const lastScanAt = lastScanMap.get(user.id) || null;

    if (!user.last_login_at) return lastScanAt;
    if (!lastScanAt) return user.last_login_at;

    return new Date(user.last_login_at).getTime() >= new Date(lastScanAt).getTime()
      ? user.last_login_at
      : lastScanAt;
  };

  const hasConsumerLaneConfirmation = (user: User): boolean => {
    if (!user.consumer_claim_confirmed_at) {
      return false;
    }

    const org = organizations.find((candidate) => candidate.id === user.organization_id);
    const isLinkedShopProfile = Boolean(org && org.org_type_code === 'SHOP' && user.referral_phone);

    return !isLinkedShopProfile;
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Toggle direction if clicking same field
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      // Set new field with default ascending direction
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      // Select all filtered users except current user
      const newSelected = new Set(
        filteredUsers.filter((u) => u.id !== userProfile.id).map((u) => u.id),
      );
      setSelectedUsers(newSelected);
    } else {
      setSelectedUsers(new Set());
    }
  };

  const handleSelectUser = (userId: string, checked: boolean) => {
    const newSelected = new Set(selectedUsers);
    if (checked) {
      newSelected.add(userId);
    } else {
      newSelected.delete(userId);
    }
    setSelectedUsers(newSelected);
  };

  const handleBulkDelete = async () => {
    if (selectedUsers.size === 0) return;

    // Validate levels before proceeding
    const currentUserLevel = resolveCurrentUserLevel();
    if (!canManageUserDeletion()) {
      toast({
        title: "Access Denied",
        description: "Only HQ Admin or Super Admin can delete users.",
        variant: "destructive",
      });
      return;
    }

    const ids = Array.from(selectedUsers);

    // Check if any selected user has higher privileges (lower role level number)
    // Note: lower role_level = higher privilege (e.g. 1 is Super Admin)
    const usersToDelete = users.filter(u => ids.includes(u.id));
    const unauthorized = usersToDelete.filter(u => {
      const level = (u as any).roles?.role_level || 999;
      return outranksViewer(level, currentUserLevel);
    });

    if (unauthorized.length > 0) {
      toast({
        title: "Permission Denied",
        description: `You cannot delete ${unauthorized.length} users because they have higher privileges than you.`,
        variant: "destructive"
      });
      return;
    }

    if (ids.length === 1) {
      const targetUser = usersToDelete[0];
      if (!targetUser) {
        toast({
          title: "User Not Found",
          description: "The selected user could not be loaded. Please refresh and try again.",
          variant: "destructive",
        });
        return;
      }

      setSelectedUsers(new Set());
      await handleDeleteUser(
        targetUser.id,
        targetUser.full_name || targetUser.email || "selected user",
      );
      return;
    }

    toast({
      title: "OTP Required",
      description: "Bulk delete is disabled because each user deletion requires OTP confirmation. Delete users one at a time.",
      variant: "default",
    });
    return;
  };

  const handleSaveUser = async (
    userData: Partial<UserType> & { password?: string },
    avatarFile?: File | null,
    access?: EditAccessSubmission,
  ) => {
    try {
      setIsSaving(true);
      const currentUserLevel = resolveCurrentUserLevel();

      const buildHrPayload = () => {
        const payload: Record<string, any> = {}
        if (userData.department_id) payload.department_id = userData.department_id;
        if ((userData as any).position_id) payload.position_id = (userData as any).position_id;
        if ((userData as any).manager_user_id) payload.manager_user_id = (userData as any).manager_user_id;
        if ((userData as any).employment_type) payload.employment_type = (userData as any).employment_type;
        if ((userData as any).join_date) payload.join_date = (userData as any).join_date;
        if ((userData as any).employment_status) payload.employment_status = (userData as any).employment_status;
        return payload;
      };

      // Validate Role Level permissions
      if (userData.role_code) {
        const targetRole = roles.find(r => r.role_code === userData.role_code);
        if (targetRole && outranksViewer(targetRole.role_level, currentUserLevel)) {
          throw new Error("You cannot assign a role level higher than your own.");
        }
      }

      if (editingUser) {
        // UPDATE existing user

        // Check if allow to edit this user
        // We need to look up the level of the user being edited.
        // The editingUser object comes from state, let's see if it has the nested role info
        // or check against the roles list
        const targetUserRoleCode = editingUser.role_code;
        const targetUserRole = roles.find(r => r.role_code === targetUserRoleCode);
        const targetUserLevel = targetUserRole?.role_level || 999;

        if (outranksViewer(targetUserLevel, currentUserLevel)) {
          throw new Error("You cannot edit a user with a higher role level than your own.");
        }

        let updateData: any = {
          full_name: userData.full_name,
          call_name: (userData as any).call_name || null,
          phone: userData.phone,
          role_code: userData.role_code,
          organization_id: userData.organization_id,
          is_active: userData.is_active ?? true,
        };

        const hasProfileChanges = hasMeaningfulUserChanges(editingUser, userData) || Boolean(avatarFile);

        // Include end user / independent user fields if present
        if ("shop_name" in userData) updateData.shop_name = (userData as any).shop_name || null;
        if ("address" in userData) updateData.address = (userData as any).address || null;
        if ("referral_phone" in userData) updateData.referral_phone = (userData as any).referral_phone || null;
        if ("can_be_reference" in userData) updateData.can_be_reference = !!(userData as any).can_be_reference;
        if ("bank_id" in userData) updateData.bank_id = (userData as any).bank_id || null;
        if ("bank_account_number" in userData) updateData.bank_account_number = (userData as any).bank_account_number || null;
        if ("bank_account_holder_name" in userData) updateData.bank_account_holder_name = (userData as any).bank_account_holder_name || null;
        if ("department_id" in userData) updateData.department_id = (userData as any).department_id || null;
        if ("position_id" in userData) updateData.position_id = (userData as any).position_id || null;
        if ("manager_user_id" in userData) updateData.manager_user_id = (userData as any).manager_user_id || null;
        if ("employment_type" in userData) updateData.employment_type = (userData as any).employment_type || null;
        if ("join_date" in userData) updateData.join_date = (userData as any).join_date || null;
        if ("employment_status" in userData) updateData.employment_status = (userData as any).employment_status || 'active';

        // Handle avatar upload
        if (avatarFile) {
          try {
            // Compress avatar first
            const compressionResult = await compressAvatar(avatarFile);

            toast({
              title: "🖼️ Avatar Compressed",
              description: `${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`,
            });

            // Delete old avatar if exists
            if (editingUser.avatar_url) {
              const oldPath = editingUser.avatar_url
                .split("/")
                .pop()
                ?.split("?")[0];
              if (oldPath) {
                await supabase.storage
                  .from("avatars")
                  .remove([`${editingUser.id}/${oldPath}`]);
              }
            }

            // Upload new avatar
            const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
            const filePath = `${editingUser.id}/${fileName}`;

            const { error: uploadError } = await supabase.storage
              .from("avatars")
              .upload(filePath, compressionResult.file, {
                contentType: compressionResult.file.type,
                cacheControl: "3600",
                upsert: true,
              });

            if (uploadError) {
              console.error("Avatar upload error:", uploadError);
              const errorMsg = uploadError.message?.includes(
                "maximum allowed size",
              )
                ? "Avatar upload failed. Image should auto-compress to ~10KB. Please try a different image."
                : `Avatar upload failed: ${uploadError.message}`;
              throw new Error(errorMsg);
            }

            // Get public URL without cache-busting params (will be added in display)
            const { data: urlData } = supabase.storage
              .from("avatars")
              .getPublicUrl(filePath);

            updateData.avatar_url = urlData.publicUrl;
          } catch (avatarError: any) {
            console.error("Avatar upload error:", avatarError);
            toast({
              title: "Warning",
              description:
                avatarError.message ||
                "Avatar upload failed, but user data saved.",
              variant: "default",
            });
          }
        }

        // Update the profile. When only Group Policy changes are pending nothing in the profile changed, so it is not rewritten.
        if (hasProfileChanges || !access) {
          const result = await updateUserWithAuth(editingUser.id, updateData, {
            id: userProfile.id,
            role_code: userProfile.role_code,
          });

          if (!result.success)
            throw new Error(result.error || "Failed to update user");
        }

        // Group Policy changes are applied AFTER the profile, through the same endpoint as People & Access. Success is only
        // reported when every change was applied; a partial result keeps the form open with exactly what happened.
        let accessMessage = "";
        if (access) {
          const outcome = await access.apply();
          if (!outcome.allApplied) {
            await loadUsers();
            throw new Error(
              `${hasProfileChanges ? "The profile changes were saved. " : ""}${outcome.message} The form now shows what is stored.`,
            );
          }
          accessMessage = ` ${outcome.message}`;
        }

        toast({
          title: "Success",
          description: `${userData.full_name} updated successfully.${accessMessage}`,
        });
        setDialogOpen(false);
        setEditingUser(null);
        await loadUsers();
      } else {
        // CREATE new user
        // A linked HR employee keeps their existing login, so no password is required for them.
        const linkedUserId = (userData as any).linked_user_id as string | undefined;
        if (
          !userData.email ||
          !userData.full_name ||
          (!userData.password && !linkedUserId)
        ) {
          throw new Error("Email, Name, and Password are required");
        }

        const result = await createUserWithAuth({
          email: userData.email,
          password: userData.password || "",
          full_name: userData.full_name,
          call_name: (userData as any).call_name || undefined,
          // No legacy role/level: the server creates the account without legacy access and rejects any value sent here.
          organization_id:
            userData.organization_id || undefined, // Don't auto-assign to admin's org - allow independent users
          phone: userData.phone || undefined,
          is_active: true, // new users are always created Active
          shop_name: (userData as any).shop_name || undefined,
          address: (userData as any).address || undefined,
          referral_phone: (userData as any).referral_phone || undefined,
          bank_id: (userData as any).bank_id || undefined,
          bank_account_number: (userData as any).bank_account_number || undefined,
          bank_account_holder_name: (userData as any).bank_account_holder_name || undefined,
          department_id: (userData as any).department_id || undefined,
          position_id: (userData as any).position_id || undefined,
          manager_user_id: (userData as any).manager_user_id || undefined,
          employment_type: (userData as any).employment_type || undefined,
          join_date: (userData as any).join_date || undefined,
          employment_status: (userData as any).employment_status || 'active',
          can_be_reference: Boolean((userData as any).can_be_reference),
          // 'self' = employee self-service only: no business role is granted.
          // 'self' = employee self-service only; 'profiles' = the Group Policies chosen below (each with its own scope).
          initial_role_id: (userData as any).initial_role_id && !['self', 'profiles'].includes((userData as any).initial_role_id) ? (userData as any).initial_role_id : null,
          initial_profiles: (userData as any).initial_role_id === 'profiles'
            ? ((userData as any).initial_profiles || []).filter((p: any) => p.roleId && p.scopeId).map((p: any) => ({ role_id: p.roleId, scope_id: p.scopeId }))
            : null,
          linked_user_id: linkedUserId || null,
          // HQ only: Employee Self Service is the default (true); an explicit exclusion travels as false. Re-judged on the server.
          ...(typeof (userData as any).include_ess === 'boolean' ? { include_ess: (userData as any).include_ess } : {}),
        }, {
          id: userProfile.id,
          role_code: userProfile.role_code,
        });

        if (!result.success) {
          // The account exists but a later step failed: say so honestly and refresh the list so it is visible.
          // A retry cannot create a duplicate (the identity check now finds the account).
          if ((result as any).partial) {
            await loadUsers();
            throw new Error(`${result.error || "Provisioning was only partly completed."} The account exists, so do not create it again: open it in the list to finish.`);
          }
          // Provide friendly error messages for common errors
          let errorMessage = result.error || "Failed to create user";

          if (
            errorMessage.toLowerCase().includes("already been registered") ||
            errorMessage.toLowerCase().includes("already exists") ||
            errorMessage.toLowerCase().includes("duplicate")
          ) {
            errorMessage = `The email address "${userData.email}" is already registered in the system. Please use a different email address.`;
          }

          throw new Error(errorMessage);
        }

        if (!result.user_id) {
          throw new Error("No user ID returned after creating user");
        }

        if ((result as any).reused) {
          // Identity resolution found this person already in the organization:
          // nothing was duplicated and their existing profile is left untouched.
          toast({ title: (result as any).linked ? "Employee linked" : "Existing account kept", description: (result as any).message });
          setDialogOpen(false);
          await loadUsers();
          return;
        }

        // Upload avatar if provided
        if (avatarFile) {
          try {
            // Compress avatar first
            const compressionResult = await compressAvatar(avatarFile);

            toast({
              title: "🖼️ Avatar Compressed",
              description: `${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`,
            });

            const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
            const filePath = `${result.user_id}/${fileName}`;

            const { error: uploadError } = await supabase.storage
              .from("avatars")
              .upload(filePath, compressionResult.file, {
                contentType: compressionResult.file.type,
                cacheControl: "3600",
                upsert: true,
              });

            if (!uploadError) {
              const { data: urlData } = supabase.storage
                .from("avatars")
                .getPublicUrl(filePath);

              // Store clean URL without cache-busting params
              const { error: updateError } = await (supabase as any)
                .from("users")
                .update({ avatar_url: urlData.publicUrl })
                .eq("id", result.user_id);

              if (updateError) {
                console.error("Avatar URL update error:", updateError);
              }
            } else {
              console.error("Avatar upload error:", uploadError);
              const errorMsg = uploadError.message?.includes(
                "maximum allowed size",
              )
                ? "Avatar upload failed. Image should auto-compress to ~10KB. Please try a different image."
                : `Avatar upload failed: ${uploadError.message}`;
              toast({
                title: "Avatar Upload Warning",
                description: errorMsg,
                variant: "default",
              });
            }
          } catch (avatarError: any) {
            console.error("Avatar upload error:", avatarError);
            toast({
              title: "Avatar Upload Warning",
              description: avatarError.message || "Failed to upload avatar",
              variant: "default",
            });
          }
        }

        console.log("✅ User created successfully, reloading user list...");
        toast({
          title: "Success",
          description: `${userData.full_name} created successfully`,
        });

        // Small delay to ensure database transaction completes
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Force reload users to update the list
        await loadUsers();
        console.log("🔄 User list reloaded after creation");
      }
    } catch (error) {
      console.error("❌ Error saving user:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to save user",
        variant: "destructive",
      });
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Account lifecycle from User Management. SUSPENDED is a temporary hold:
   * business access is suspended and restored exactly on resume. DISABLED is
   * treated as leaving: every business assignment is revoked and reactivation
   * restores only the automatic employee baseline.
   */
  const handleAccountStatus = async (
    userId: string,
    target: "ACTIVE" | "SUSPENDED" | "DISABLED",
    userName: string,
  ) => {
    const confirmText = target === "DISABLED"
      ? `Deactivate ${userName}?\n\nThis is treated as the person leaving: ALL their business access (granted and automatic) is removed. Activating them later restores only the employee baseline; other access must be granted again.\n\nTo pause access temporarily, use Suspend instead.`
      : target === "SUSPENDED"
        ? `Suspend ${userName}?\n\nSign-in and business access are paused. Resuming restores exactly the access they had.`
        : null;
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      setIsSaving(true);

      const currentUserLevel = resolveCurrentUserLevel();
      const targetUser = users.find(u => u.id === userId);
      // Access nested roles safely
      const targetUserLevel = (targetUser as any)?.roles?.role_level || 999;

      if (outranksViewer(targetUserLevel, currentUserLevel)) {
        throw new Error("You cannot modify a user with a higher role level than your own.");
      }

      // Account lifecycle runs on the server (S&A platform.identity.disable);
      // the database rejects direct browser writes to is_active.
      const result = await setUserAccountStatus(
        userId,
        target,
        target === "DISABLED" ? "Deactivated in User Management" : target === "SUSPENDED" ? "Suspended in User Management" : "Activated in User Management",
      );

      if (!result.success) throw new Error(result.error || "Failed to update user status");

      toast({
        title: "Success",
        description: `${userName} ${target === "ACTIVE" ? "activated" : target === "SUSPENDED" ? "suspended" : "deactivated"} successfully`,
      });

      await loadUsers();
    } catch (error) {
      console.error("Error toggling user status:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update user status",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // --- OTP-protected deletion state ---
  const [deleteOtpOpen, setDeleteOtpOpen] = useState(false);
  const [deleteOtpStep, setDeleteOtpStep] = useState<'confirm' | 'otp' | 'deleting'>('confirm');
  const [deleteTargetUser, setDeleteTargetUser] = useState<{ id: string; name: string } | null>(null);
  const [deleteOtpCode, setDeleteOtpCode] = useState('');
  const [deleteOtpCodeId, setDeleteOtpCodeId] = useState('');
  const [deleteOtpMaskedRecipient, setDeleteOtpMaskedRecipient] = useState('');
  const [deleteOtpChannel, setDeleteOtpChannel] = useState<'whatsapp' | 'sms' | 'email' | null>(null);
  const [deleteOtpError, setDeleteOtpError] = useState('');
  const [deleteOtpSending, setDeleteOtpSending] = useState(false);
  const [deleteOtpRemovalMode, setDeleteOtpRemovalMode] = useState<'delete' | 'archive' | null>(null);

  const handleDeleteUser = async (userId: string, userName: string) => {
    if (!canManageUserDeletion()) {
      toast({ title: "Access Denied", description: "Only HQ Admin or Super Admin can delete users.", variant: "destructive" });
      return;
    }
    if (userId === userProfile.id) {
      toast({ title: "Not Allowed", description: "Cannot delete your own account.", variant: "destructive" });
      return;
    }
    setDeleteTargetUser({ id: userId, name: userName });
    setDeleteOtpStep('confirm');
    setDeleteOtpCode('');
    setDeleteOtpCodeId('');
    setDeleteOtpMaskedRecipient('');
    setDeleteOtpChannel(null);
    setDeleteOtpError('');
    setDeleteOtpRemovalMode(null);
    setDeleteOtpOpen(true);
  };

  const handleDeleteOtpRequest = async () => {
    if (!deleteTargetUser) return;
    setDeleteOtpSending(true);
    setDeleteOtpError('');
    try {
      const res = await fetch('/api/admin/delete-user-otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: deleteTargetUser.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send OTP');
      setDeleteOtpCodeId(data.codeId);
      setDeleteOtpMaskedRecipient(data.maskedRecipient || data.maskedEmail || data.maskedPhone || '');
      setDeleteOtpChannel(
        data.channel === 'email' ? 'email' : data.channel === 'sms' ? 'sms' : 'whatsapp',
      );
      setDeleteOtpRemovalMode(data.removalMode === 'archive' ? 'archive' : 'delete');
      setDeleteOtpStep('otp');
    } catch (err: any) {
      setDeleteOtpError(err.message);
    } finally {
      setDeleteOtpSending(false);
    }
  };

  const handleDeleteOtpVerify = async () => {
    if (!deleteTargetUser || !deleteOtpCode || !deleteOtpCodeId) return;
    setDeleteOtpSending(true);
    setDeleteOtpError('');
    try {
      setDeleteOtpStep('deleting');
      const res = await fetch('/api/admin/delete-user-otp/verify-and-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: deleteTargetUser.id, code: deleteOtpCode, codeId: deleteOtpCodeId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDeleteOtpStep('otp');
        throw new Error(data.error || 'Verification failed');
      }
      toast({
        title: data.mode === 'archive' ? "User Archived" : "User Deleted",
        description: data.message || `${deleteTargetUser.name} removed successfully`,
      });
      setDeleteOtpOpen(false);
      await loadUsers();
    } catch (err: any) {
      setDeleteOtpError(err.message);
    } finally {
      setDeleteOtpSending(false);
    }
  };

  const organizationById = useMemo(
    () => new Map(organizations.map((org) => [org.id, org])),
    [organizations],
  );
  const orgTypeOptions = useMemo(() => buildOrgTypeOptions(organizations), [organizations]);
  const orgFilterOptions = useMemo(
    () => buildOrgOptions(organizationsForType(organizations, orgTypeFilter)),
    [organizations, orgTypeFilter],
  );
  const organizationsLoading = !organizationsLoaded && !organizationsLoadFailed;

  // A type change drops the selected organization only when it no longer belongs to that type.
  const handleOrgTypeFilterChange = (nextType: string) => {
    setOrgTypeFilter(nextType);
    setOrgFilter((current) => reconcileOrgSelection(organizations, nextType, current));
  };

  // The catalogue can change (reload, edited organization); keep the selection valid for the current type.
  useEffect(() => {
    if (!organizationsLoaded) return;
    setOrgFilter((current) => reconcileOrgSelection(organizations, orgTypeFilter, current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizations, organizationsLoaded]);

  const filteredUsers = useMemo(() => {
    return users
      .filter((user) => {
        // Search filter with phone normalization
        const normalizePhoneForSearch = (p: string) => {
          if (!p) return '';
          // Strip all non-digits for comparison
          return p.replace(/\D/g, '');
        };

        const searchLower = searchQuery.toLowerCase();
        const searchDigits = normalizePhoneForSearch(searchQuery);
        const userPhoneDigits = normalizePhoneForSearch(user.phone || '');

        const matchesSearch =
          user.call_name?.toLowerCase().includes(searchLower) ||
          user.full_name?.toLowerCase().includes(searchLower) ||
          user.email.toLowerCase().includes(searchLower) ||
          user.phone?.includes(searchQuery) ||
          // Also match normalized phone (digits only)
          (searchDigits.length >= 8 && userPhoneDigits.includes(searchDigits));

        // Role filter
        const matchesRole = !roleFilter || user.role_code === roleFilter;

        // Organization Type + Organization filters (same catalogue as the dropdowns)
        const matchesOrganization = userMatchesOrgFilters(user, organizationById, orgTypeFilter, orgFilter);

        // Status filter
        const matchesStatus =
          !statusFilter ||
          (statusFilter === "online" && isUserOnline(getLatestActivityAt(user))) ||
          (statusFilter === "active" && user.is_active) ||
          (statusFilter === "inactive" && !user.is_active) ||
          (statusFilter === "verified" && user.is_verified) ||
          (statusFilter === "unverified" && !user.is_verified) ||
          (statusFilter === "consumer-verified" && hasConsumerLaneConfirmation(user));
        const matchesProgram =
          !programFilter || getProgramLabelFromMemberships(user.loyalty_program_user_memberships) === programFilter;

        return (
          matchesSearch &&
          matchesRole &&
          matchesOrganization &&
          matchesStatus &&
          matchesProgram
        );
      })
      .sort((a, b) => {
        let aVal: any = a[sortField];
        let bVal: any = b[sortField];

        // Handle null values
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

        // Handle different data types
        if (sortField === "created_at") {
          aVal = new Date(aVal).getTime();
          bVal = new Date(bVal).getTime();
        } else if (sortField === "last_login_at") {
          aVal = getLatestActivityAt(a);
          bVal = getLatestActivityAt(b);
          aVal = aVal ? new Date(aVal).getTime() : 0;
          bVal = bVal ? new Date(bVal).getTime() : 0;
        } else if (sortField === "is_active") {
          aVal = aVal ? 1 : 0;
          bVal = bVal ? 1 : 0;
        } else if (sortField === "full_name") {
          aVal = getUserDisplayName(a).toLowerCase();
          bVal = getUserDisplayName(b).toLowerCase();
        } else if (sortField === "role_code") {
          aVal =
            roles.find((r) => r.role_code === a.role_code)?.role_name ||
            a.role_code;
          bVal =
            roles.find((r) => r.role_code === b.role_code)?.role_name ||
            b.role_code;
          aVal = aVal.toLowerCase();
          bVal = bVal.toLowerCase();
        } else if (sortField === "organization_id") {
          aVal =
            organizations.find((o) => o.id === a.organization_id)?.org_name ||
            "";
          bVal =
            organizations.find((o) => o.id === b.organization_id)?.org_name ||
            "";
          aVal = aVal.toLowerCase();
          bVal = bVal.toLowerCase();
        }

        if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
        if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
        return 0;
      });
  }, [
    users,
    searchQuery,
    roleFilter,
    orgFilter,
    orgTypeFilter,
    statusFilter,
    programFilter,
    sortField,
    sortDirection,
    organizations,
    organizationById,
    roles,
    lastScanMap,
  ]);

  // Pagination calculations - handle "All" option when pageSize is -1
  const effectivePageSize = pageSize === -1 ? filteredUsers.length : pageSize;
  const totalPages = pageSize === -1 ? 1 : Math.ceil(filteredUsers.length / pageSize);
  const startIndex = (currentPage - 1) * effectivePageSize;
  const endIndex = startIndex + effectivePageSize;
  const paginatedUsers = filteredUsers.slice(startIndex, endIndex);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [
    searchQuery,
    roleFilter,
    orgFilter,
    orgTypeFilter,
    statusFilter,
    programFilter,
    pageSize,
  ]);

  const stats = {
    total: filteredUsers.length, // Show filtered count based on active filters
    active: filteredUsers.filter((u) => u.is_active).length,
    verified: filteredUsers.filter((u) => u.is_verified).length,
    online: filteredUsers.filter((u) => isUserOnline(getLatestActivityAt(u))).length,
  };

  const getInitials = (name: string | null): string => {
    if (!name) return "U";
    const parts = name.trim().split(" ");
    if (parts.length >= 2)
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  };

  const getRoleBadgeColor = (roleCode: string): string => {
    const colors: Record<string, string> = {
      SUPER: "bg-purple-100 text-purple-800",
      HQ_ADMIN: "bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]",
      MANU_ADMIN: "bg-indigo-100 text-indigo-800",
      DIST_ADMIN: "bg-green-100 text-green-800",
      WH_MANAGER: "bg-orange-100 text-orange-800",
      SHOP_MANAGER: "bg-pink-100 text-pink-800",
      USER: "bg-gray-100 text-gray-800",
    };
    return colors[roleCode] || "bg-gray-100 text-gray-800";
  };

  // Use shared getOrgTypeName from @/lib/utils/orgHierarchy

  if (editUserId) {
    return loading ? <div role="status">Loading user...</div> : (
      <UserDialogNew user={editingUser} roles={roles} organizations={organizations}
        open={dialogOpen} isSaving={isSaving} currentUserRoleLevel={currentUserLevel} rootAccess={rootAccess}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) onEditClose?.(); }}
        onSave={handleSaveUser} />
    );
  }

  if (loading) {
    return <SeraLoadingState variant="page" label="Loading users" />;
  }

  return (
    <div className="sera-sc-page space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">User Management</h1>
          <p className="text-[var(--sera-muted)]">
            Manage system users and access permissions
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingUser(null);
            setDialogOpen(true);
          }}
          className="w-full shrink-0 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white sm:w-auto"
          disabled={isSaving}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add User
        </Button>
      </div>

      <UserDialogNew
        user={editingUser}
        roles={roles}
        organizations={organizations}
        organizationsLoaded={organizationsLoaded}
        open={dialogOpen}
        isSaving={isSaving}
        currentUserRoleLevel={currentUserLevel} rootAccess={rootAccess}
        onOpenChange={setDialogOpen}
        onOpenExistingUser={(userId) => {
          // "Open existing user": leave the Add User form and open that person's record, if the list can show them.
          const existing = users.find((u) => u.id === userId);
          if (!existing) {
            toast({ title: "Not in the current list", description: "Search for this person in the user list to open them." });
            return;
          }
          setDialogOpen(false);
          setEditingUser(existing);
          setTimeout(() => setDialogOpen(true), 0);
        }}
        onSave={handleSaveUser}
      />

      <Dialog open={organizationDialogOpen} onOpenChange={(open) => {
        if (!organizationSaving) setOrganizationDialogOpen(open);
      }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-[var(--sera-orange)]" />
              Organization Master Data
            </DialogTitle>
            <DialogDescription>
              {organizationLoading
                ? "Loading organization details..."
                : canEditSelectedOrganization
                  ? "Super Admin can update this shop organization from User Management."
                  : "View-only. Editing is available only to Super Admin for users attached to a shop organization."}
            </DialogDescription>
          </DialogHeader>

          {organizationLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-[var(--sera-orange)] animate-spin" />
            </div>
          ) : selectedOrganization ? (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Organization Code</label>
                  <Input value={selectedOrganization.org_code || ""} disabled />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Organization Type</label>
                  <Input value={getOrgTypeName(selectedOrganization.org_type_code || "")} disabled />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Status</label>
                  <Input value={selectedOrganization.is_active === false ? "Inactive" : "Active"} disabled />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Organization Name</label>
                  <Input
                    value={organizationForm.org_name || ""}
                    onChange={(event) => handleOrganizationFieldChange("org_name", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Branch</label>
                  <Input
                    value={organizationForm.branch || ""}
                    onChange={(event) => handleOrganizationFieldChange("branch", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Contact Name</label>
                  <Input
                    value={organizationForm.contact_name || ""}
                    onChange={(event) => handleOrganizationFieldChange("contact_name", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Contact Title</label>
                  <Input
                    value={organizationForm.contact_title || ""}
                    onChange={(event) => handleOrganizationFieldChange("contact_title", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Contact Phone</label>
                  <Input
                    value={organizationForm.contact_phone || ""}
                    onChange={(event) => handleOrganizationFieldChange("contact_phone", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Contact Email</label>
                  <Input
                    value={organizationForm.contact_email || ""}
                    onChange={(event) => handleOrganizationFieldChange("contact_email", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Address</label>
                  <textarea
                    value={organizationForm.address || ""}
                    onChange={(event) => handleOrganizationFieldChange("address", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                    className="min-h-[84px] w-full rounded-md border border-[var(--sera-line)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Address Line 2</label>
                  <textarea
                    value={organizationForm.address_line2 || ""}
                    onChange={(event) => handleOrganizationFieldChange("address_line2", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                    className="min-h-[84px] w-full rounded-md border border-[var(--sera-line)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">City</label>
                  <Input
                    value={organizationForm.city || ""}
                    onChange={(event) => handleOrganizationFieldChange("city", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Postal Code</label>
                  <Input
                    value={organizationForm.postal_code || ""}
                    onChange={(event) => handleOrganizationFieldChange("postal_code", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Country Code</label>
                  <Input
                    value={organizationForm.country_code || ""}
                    onChange={(event) => handleOrganizationFieldChange("country_code", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Website</label>
                  <Input
                    value={organizationForm.website || ""}
                    onChange={(event) => handleOrganizationFieldChange("website", event.target.value)}
                    disabled={!canEditSelectedOrganization}
                  />
                </div>
              </div>

              {selectedOrganization.org_type_code === "SHOP" && (
                <div className="rounded-lg border p-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Hot Flavour Brands</label>
                    <Input
                      value={organizationForm.hot_flavour_brands || ""}
                      onChange={(event) => handleOrganizationFieldChange("hot_flavour_brands", event.target.value)}
                      disabled={!canEditSelectedOrganization}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <label className="flex items-center gap-2 text-sm text-[var(--sera-ink)]/80">
                      <Checkbox
                        checked={Boolean(organizationForm.sells_serapod_flavour)}
                        onCheckedChange={(checked) => handleOrganizationFieldChange("sells_serapod_flavour", checked === true)}
                        disabled={!canEditSelectedOrganization}
                      />
                      Sells Serapod Flavour
                    </label>
                    <label className="flex items-center gap-2 text-sm text-[var(--sera-ink)]/80">
                      <Checkbox
                        checked={Boolean(organizationForm.sells_sbox)}
                        onCheckedChange={(checked) => handleOrganizationFieldChange("sells_sbox", checked === true)}
                        disabled={!canEditSelectedOrganization}
                      />
                      Sells S.Box
                    </label>
                    <label className="flex items-center gap-2 text-sm text-[var(--sera-ink)]/80">
                      <Checkbox
                        checked={Boolean(organizationForm.sells_sbox_special_edition)}
                        onCheckedChange={(checked) => handleOrganizationFieldChange("sells_sbox_special_edition", checked === true)}
                        disabled={!canEditSelectedOrganization}
                      />
                      Sells S.Box Special Edition
                    </label>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOrganizationDialogOpen(false)}
              disabled={organizationSaving}
            >
              Close
            </Button>
            {canEditSelectedOrganization && (
              <Button onClick={handleSaveOrganization} disabled={organizationSaving}>
                {organizationSaving ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                Save Organization
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-[var(--sera-muted)] mb-1">Total Users</p>
                <p className="text-2xl sm:text-3xl font-bold text-[var(--sera-ink)]">
                  {stats.total}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-[var(--sera-orange)]/[0.06] flex items-center justify-center shrink-0">
                <Users className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--sera-orange)]" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-[var(--sera-muted)] mb-1">Online Now</p>
                <p className="text-2xl sm:text-3xl font-bold text-emerald-600">
                  {stats.online}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-emerald-50 flex items-center justify-center relative shrink-0">
                <Circle className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-600 fill-emerald-500" />
                <span className="absolute top-1 right-1 w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-[var(--sera-muted)] mb-1">Active Users</p>
                <p className="text-2xl sm:text-3xl font-bold text-green-600">
                  {stats.active}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
                <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-green-600" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-[var(--sera-muted)] mb-1">Verified Users</p>
                <p className="text-2xl sm:text-3xl font-bold text-purple-600">
                  {stats.verified}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-purple-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters and Search */}
      <Card className="sera-sc-panel overflow-hidden shadow-none">
        <CardContent className="pt-6 space-y-4">
          {/* Filters Row */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* Role Filter */}
            <div>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                Filter by Role
              </label>
              <select
                className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 bg-white"
                onChange={(e) => setRoleFilter(e.target.value)}
                value={roleFilter}
              >
                <option value="">All Roles</option>
                {roles.map((role) => (
                  <option key={role.role_code} value={role.role_code}>
                    {role.role_name}
                  </option>
                ))}
              </select>
            </div>

            {/* Organization Type Filter */}
            <div>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                Filter by Organization Type
              </label>
              <select
                className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 bg-white"
                onChange={(e) => handleOrgTypeFilterChange(e.target.value)}
                value={orgTypeFilter}
                aria-label="Filter by Organization Type"
              >
                <option value="">All Types</option>
                {orgTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Organization Filter */}
            <div>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                Filter by Organization
              </label>
              <select
                className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 bg-white"
                onChange={(e) => setOrgFilter(e.target.value)}
                value={orgFilter}
                aria-label="Filter by Organization"
                aria-busy={organizationsLoading}
              >
                <option value="">All Organizations</option>
                {organizationsLoading ? (
                  <option value="" disabled>Loading organizations…</option>
                ) : organizationsLoadFailed ? (
                  <option value="" disabled>Could not load organizations</option>
                ) : orgFilterOptions.length === 0 ? (
                  <option value="" disabled>
                    {orgTypeFilter ? "No organizations of this type" : "No organizations available"}
                  </option>
                ) : (
                  orgFilterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* Status Filter */}
            <div>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                Filter by Status
              </label>
              <select
                className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 bg-white"
                onChange={(e) => setStatusFilter(e.target.value)}
                value={statusFilter}
              >
                <option value="">All Status</option>
                <option value="online">🟢 Online Now</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="verified">Verified</option>
                <option value="unverified">Unverified</option>
                <option value="consumer-verified">Consumer Verified</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                Filter by Program
              </label>
              <select
                className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 bg-white"
                onChange={(e) => setProgramFilter(e.target.value)}
                value={programFilter}
              >
                {PROGRAM_FILTER_OPTIONS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Search Box */}
          <div className="flex items-center gap-2">
            <Search className="w-5 h-5 text-[var(--sera-muted)]/70" />
            <Input
              placeholder="Search users by name, email, or phone..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1"
            />
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card className="sera-sc-panel overflow-hidden shadow-none">
        <CardContent className="pt-6">
          {/* Delete Progress Indicator */}
          {deleteProgress && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {deleteProgress.isDeleting ? (
                    <Loader2 className="w-5 h-5 text-red-600 animate-spin" />
                  ) : (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  )}
                  <span className="text-sm font-medium text-red-900">
                    {deleteProgress.message}
                  </span>
                </div>
                <span className="text-sm text-red-700">
                  {deleteProgress.current} / {deleteProgress.total}
                </span>
              </div>
              <Progress value={deleteProgress.progress} className="h-2" />
              <div className="flex justify-between text-xs text-red-600">
                <span>
                  ✓ {deleteProgress.success} success
                </span>
                {deleteProgress.errors > 0 && (
                  <span>
                    ✗ {deleteProgress.errors} errors
                  </span>
                )}
              </div>
            </div>
          )}

          {selectedUsers.size > 0 && !deleteProgress && (
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-lg p-3 sm:p-4">
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle className="w-5 h-5 text-[var(--sera-orange)] shrink-0" />
                <span className="text-sm font-medium text-[var(--sera-ink)]">
                  {selectedUsers.size} user{selectedUsers.size > 1 ? "s" : ""}{" "}
                  selected
                </span>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={isSaving}
                className="w-full gap-2 sm:w-auto"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                <span className="truncate">
                  {canManageUserDeletion()
                    ? selectedUsers.size === 1
                      ? "Delete (OTP)"
                      : "Delete One at a Time"
                    : `Delete ${selectedUsers.size}`}
                </span>
              </Button>
            </div>
          )}
          {filteredUsers.length > 0 ? (
            <>
              {/* Fixed layout keeps column widths independent of which rows the
                  org-type filter returns; the Table wrapper is the only horizontal
                  scroller and Actions stays pinned right from md up. */}
              <div className="border rounded-lg overflow-hidden">
                <Table ref={setUsersTableEl} className="table-fixed min-w-[1200px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={
                            filteredUsers.filter((u) => u.id !== userProfile.id)
                              .length > 0 &&
                            filteredUsers
                              .filter((u) => u.id !== userProfile.id)
                              .every((u) => selectedUsers.has(u.id))
                          }
                          onCheckedChange={handleSelectAll}
                          disabled={
                            filteredUsers.filter((u) => u.id !== userProfile.id)
                              .length === 0
                          }
                        />
                      </TableHead>
                      <TableHead className="w-12 text-center">#</TableHead>
                      <TableHead className="whitespace-nowrap">
                        <button
                          onClick={() => handleSort("full_name")}
                          className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium"
                        >
                          User
                          {sortField === "full_name" ? (
                            sortDirection === "asc" ? (
                              <ArrowUp className="w-4 h-4" />
                            ) : (
                              <ArrowDown className="w-4 h-4" />
                            )
                          ) : (
                            <ArrowUpDown className="w-4 h-4 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="w-[136px] whitespace-nowrap">
                        <button
                          onClick={() => handleSort("role_code")}
                          className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium"
                        >
                          Role
                          {sortField === "role_code" ? (
                            sortDirection === "asc" ? (
                              <ArrowUp className="w-4 h-4" />
                            ) : (
                              <ArrowDown className="w-4 h-4" />
                            )
                          ) : (
                            <ArrowUpDown className="w-4 h-4 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="w-[150px] whitespace-nowrap">
                        <button
                          onClick={() => handleSort("organization_id")}
                          className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium"
                        >
                          Organization
                          {sortField === "organization_id" ? (
                            sortDirection === "asc" ? (
                              <ArrowUp className="w-4 h-4" />
                            ) : (
                              <ArrowDown className="w-4 h-4" />
                            )
                          ) : (
                            <ArrowUpDown className="w-4 h-4 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="w-[120px] whitespace-nowrap">Program</TableHead>
                      <TableHead className="w-[150px] whitespace-nowrap">
                        <button
                          onClick={() => handleSort("referral_phone")}
                          className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium"
                        >
                          Reference
                          {sortField === "referral_phone" ? (
                            sortDirection === "asc" ? (
                              <ArrowUp className="w-4 h-4" />
                            ) : (
                              <ArrowDown className="w-4 h-4" />
                            )
                          ) : (
                            <ArrowUpDown className="w-4 h-4 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="w-[164px] whitespace-nowrap overflow-hidden">
                        <button
                          onClick={() => handleSort("last_login_at")}
                          className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium"
                        >
                          Last Activity
                          {sortField === "last_login_at" ? (
                            sortDirection === "asc" ? (
                              <ArrowUp className="w-4 h-4" />
                            ) : (
                              <ArrowDown className="w-4 h-4" />
                            )
                          ) : (
                            <ArrowUpDown className="w-4 h-4 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className={`w-[192px] px-2 text-right whitespace-nowrap bg-white md:sticky md:right-0 md:z-10 ${actionsCoverContent ? "md:shadow-[-6px_0_8px_-6px_rgba(15,23,42,0.10)]" : ""}`}>
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedUsers.map((user, index) => (
                      <TableRow key={user.id} className="group hover:bg-[var(--sera-ink)]/[0.02]">
                        <TableCell>
                          <Checkbox
                            checked={selectedUsers.has(user.id)}
                            onCheckedChange={(checked) =>
                              handleSelectUser(user.id, checked as boolean)
                            }
                            disabled={user.id === userProfile.id}
                          />
                        </TableCell>
                        <TableCell className="text-center text-[var(--sera-muted)] text-sm">
                          {startIndex + index + 1}
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="relative shrink-0">
                              <Avatar className="w-10 h-10">
                                {user.avatar_url && (
                                  <AvatarImage
                                    src={getAvatarSrc(user.avatar_url)}
                                    alt={getUserDisplayName(user)}
                                  />
                                )}
                                <AvatarFallback className="bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] text-white text-xs font-medium">
                                  {getInitials(getUserDisplayName(user))}
                                </AvatarFallback>
                              </Avatar>
                              {/* Online status indicator */}
                              {isUserOnline(getLatestActivityAt(user)) && (
                                <span
                                  className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-white rounded-full"
                                  title="Online now"
                                />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <button
                                onClick={() => {
                                  setEditingUser(user);
                                  setDialogOpen(true);
                                }}
                                className="text-[var(--sera-ink)] truncate font-medium hover:text-[var(--sera-orange)] hover:underline transition-colors text-left block max-w-full"
                                title="Click to edit user"
                              >
                                {getUserDisplayName(user)}
                              </button>
                              {user.phone && (
                                <div className="text-xs text-[var(--sera-muted)] truncate">
                                  {user.phone}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={`max-w-full ${getRoleBadgeColor(user.role_code)}`}
                          >
                            {roles.find((r) => r.role_code === user.role_code)
                              ?.role_name || user.role_code}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="min-w-0">
                            {(() => {
                              const org = organizations.find(o => o.id === user.organization_id);
                              if (!org) return <span className="text-[var(--sera-muted)]/70 italic">End User</span>;
                              if (org.org_type_code === 'SHOP') {
                                return (
                                  <div className="min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => handleOpenOrganizationDialog(user, org)}
                                      className="block max-w-full truncate text-left text-[var(--sera-ink)] font-medium hover:text-[var(--sera-orange)] hover:underline"
                                      title={org.org_name}
                                    >
                                      {org.org_name}
                                    </button>
                                    {org.branch && <span className="block truncate text-[var(--sera-muted)] text-xs" title={org.branch}>({org.branch})</span>}
                                  </div>
                                );
                              }
                              return (
                                <button
                                  type="button"
                                  onClick={() => handleOpenOrganizationDialog(user, org)}
                                  className="block max-w-full truncate text-left text-[var(--sera-ink)] hover:text-[var(--sera-orange)] hover:underline"
                                  title="View organization master data"
                                >
                                  {getOrgTypeName(org.org_type_code || "")}
                                </button>
                              );
                            })()}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-[var(--sera-ink)]">
                            {getProgramLabelFromMemberships(user.loyalty_program_user_memberships)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            if (!user.referral_phone) {
                              return <span className="text-[var(--sera-ink)]">-</span>;
                            }

                            const referenceUser = users.find((candidate) => {
                              if (!candidate.phone || candidate.id === user.id) return false;
                              return samePhone(candidate.phone, user.referral_phone);
                            });

                            if (!referenceUser) {
                              return <span className="block truncate text-[var(--sera-ink)]">{user.referral_phone}</span>;
                            }

                            return (
                              <div className="min-w-0">
                                <div className="text-[var(--sera-ink)] font-medium truncate">
                                  {getUserDisplayName(referenceUser)}
                                </div>
                                <div className="text-xs text-[var(--sera-muted)] truncate">
                                  {referenceUser.phone || user.referral_phone}
                                </div>
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="overflow-hidden">
                          <div className="flex flex-wrap items-center gap-1">
                            {isUserOnline(getLatestActivityAt(user)) && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full mr-1 animate-pulse" />
                                Online
                              </span>
                            )}
                            <span
                              className={
                                getLatestActivityAt(user)
                                  ? "text-[var(--sera-ink)]"
                                  : "text-[var(--sera-muted)]/70 italic"
                              }
                              title={formatDateTime(getLatestActivityAt(user))}
                            >
                              {formatRelativeTime(getLatestActivityAt(user))}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className={`px-2 text-right bg-white group-hover:[background-color:color-mix(in_srgb,var(--sera-ink)_2%,white)] md:sticky md:right-0 md:z-10 ${actionsCoverContent ? "md:shadow-[-6px_0_8px_-6px_rgba(15,23,42,0.10)]" : ""}`}>
                          <TooltipProvider delayDuration={150}>
                            <div className="flex flex-nowrap items-center justify-end gap-1">
                              {hasConsumerLaneConfirmation(user) && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-amber-200 bg-amber-50 text-amber-600">
                                      <Shield className="w-4 h-4" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Consumer lane confirmed on {formatDateTime(user.consumer_claim_confirmed_at)}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              {user.account_status === "SUSPENDED" ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleAccountStatus(user.id, "ACTIVE", user.full_name || user.email)}
                                  disabled={isSaving || user.id === userProfile.id}
                                  className="h-8 w-8 shrink-0 p-0 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                  title="Resume user (restores the access they had)"
                                >
                                  <PlayCircle className="w-4 h-4" />
                                </Button>
                              ) : user.is_active ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleAccountStatus(user.id, "SUSPENDED", user.full_name || user.email)}
                                  disabled={isSaving || user.id === userProfile.id}
                                  className="h-8 w-8 shrink-0 p-0 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                  title={user.id === userProfile.id ? "Cannot suspend yourself" : "Suspend user (temporary; keeps their access)"}
                                >
                                  <PauseCircle className="w-4 h-4" />
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  handleAccountStatus(
                                    user.id,
                                    user.is_active || user.account_status === "SUSPENDED" ? "DISABLED" : "ACTIVE",
                                    user.full_name || user.email,
                                  )
                                }
                                disabled={isSaving || user.id === userProfile.id}
                                className={
                                  "h-8 w-8 shrink-0 p-0 " + (user.is_active
                                    ? "text-green-600 hover:text-green-700 hover:bg-green-50"
                                    : "text-[var(--sera-muted)]/70 hover:text-[var(--sera-muted)] hover:bg-[var(--sera-ink)]/[0.02]")
                                }
                                title={
                                  user.id === userProfile.id
                                    ? "Cannot deactivate yourself"
                                    : user.is_active || user.account_status === "SUSPENDED"
                                      ? "Deactivate user (leaver: removes all business access)"
                                      : "Activate user"
                                }
                              >
                                <Power className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditingUser(user);
                                  setDialogOpen(true);
                                }}
                                disabled={isSaving}
                                className="h-8 w-8 shrink-0 p-0 text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:bg-[var(--sera-orange)]/[0.06]"
                                title="Edit user"
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              {canManageUserDeletion() && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    handleDeleteUser(
                                      user.id,
                                      user.full_name || user.email,
                                    )
                                  }
                                  disabled={isSaving || user.id === userProfile.id}
                                  className="h-8 w-8 shrink-0 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                  title={
                                    user.id === userProfile.id
                                      ? "Cannot delete yourself"
                                      : "Delete user (OTP required)"
                                  }
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </TooltipProvider>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 px-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--sera-muted)]">Rows per page:</span>
                  <select
                    className="px-2 py-1 border border-[var(--sera-line)] rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/100 bg-white"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                  >
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {size === -1 ? "All" : size}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-4">
                  <span className="text-sm text-[var(--sera-muted)]">
                    Showing {startIndex + 1} to{" "}
                    {Math.min(endIndex, filteredUsers.length)} of{" "}
                    {filteredUsers.length} users
                  </span>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1 || pageSize === -1}
                      className="hidden sm:flex"
                    >
                      First
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setCurrentPage((prev) => Math.max(1, prev - 1))
                      }
                      disabled={currentPage === 1 || pageSize === -1}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="px-3 py-1 text-sm font-medium">
                      {pageSize === -1 ? "All" : `Page ${currentPage} of ${totalPages || 1}`}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setCurrentPage((prev) => Math.min(totalPages, prev + 1))
                      }
                      disabled={currentPage >= totalPages || pageSize === -1}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage >= totalPages || pageSize === -1}
                      className="hidden sm:flex"
                    >
                      Last
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12">
              <Users className="w-12 h-12 text-[var(--sera-muted)]/70 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-[var(--sera-ink)] mb-2">
                No users found
              </h3>
              <p className="text-[var(--sera-muted)]">
                {searchQuery
                  ? "No users match your search"
                  : "Start by adding your first user"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* OTP-Protected Delete User Dialog */}
      <Dialog open={deleteOtpOpen} onOpenChange={(open) => { if (!deleteOtpSending) { setDeleteOtpOpen(open); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="w-5 h-5" />
              {deleteOtpStep === 'confirm'
                ? 'Remove User'
                : deleteOtpStep === 'otp'
                  ? 'Enter Verification Code'
                  : 'Removing User...'}
            </DialogTitle>
            <DialogDescription>
              {deleteOtpStep === 'confirm' && (
                <>A verification code will be sent to the organization contact using the <strong>User Deletion OTP</strong> routing in Notifications → Types before removing <strong>{deleteTargetUser?.name}</strong>.</>
              )}
              {deleteOtpStep === 'otp' && (
                <>
                  A 4-digit code was sent via {deleteOtpChannel === 'email' ? 'email' : deleteOtpChannel === 'sms' ? 'SMS' : 'WhatsApp'} to <strong>{deleteOtpMaskedRecipient}</strong>. Enter it below to confirm.
                  {deleteOtpRemovalMode === 'archive' && ' This account has business history, so it will be archived: its history is kept and its email and phone stay reserved (reactivate the account if the person returns).'}
                </>
              )}
              {deleteOtpStep === 'deleting' && 'Please wait while the user is being removed...'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {deleteOtpStep === 'confirm' && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <Shield className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-red-800">
                    <p className="font-medium mb-1">A history check will run before removal.</p>
                    <ul className="list-disc ml-4 space-y-0.5 text-xs">
                      <li>Users without business history are deleted permanently.</li>
                      <li>Users with orders or documents are archived to protect history. Their email and phone stay reserved; reactivate them if they return.</li>
                      <li>Archived users cannot sign in; their original email and phone are released for reuse.</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {deleteOtpStep === 'otp' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-1">Verification Code</label>
                  <Input
                    type="text"
                    maxLength={4}
                    value={deleteOtpCode}
                    onChange={(e) => setDeleteOtpCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="0000"
                    className="text-center text-2xl tracking-widest font-mono h-12"
                    autoFocus
                  />
                </div>
                <p className="text-xs text-[var(--sera-muted)] text-center">Code expires in 5 minutes</p>
              </div>
            )}

            {deleteOtpStep === 'deleting' && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-8 h-8 animate-spin text-red-600" />
              </div>
            )}

            {deleteOtpError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-600 text-center">{deleteOtpError}</p>
              </div>
            )}
          </div>

          <DialogFooter className="flex gap-2 sm:gap-2">
            {deleteOtpStep !== 'deleting' && (
              <Button variant="outline" onClick={() => setDeleteOtpOpen(false)} disabled={deleteOtpSending}>
                Cancel
              </Button>
            )}
            {deleteOtpStep === 'confirm' && (
              <Button
                variant="destructive"
                onClick={handleDeleteOtpRequest}
                disabled={deleteOtpSending}
              >
                {deleteOtpSending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending...</> : 'Check & Send Verification Code'}
              </Button>
            )}
            {deleteOtpStep === 'otp' && (
              <Button
                variant="destructive"
                onClick={handleDeleteOtpVerify}
                disabled={deleteOtpSending || deleteOtpCode.length !== 4}
              >
                {deleteOtpSending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifying...</> : deleteOtpRemovalMode === 'archive' ? 'Verify & Archive' : 'Verify & Delete'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
