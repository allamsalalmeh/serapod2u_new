/**
 * Single source of truth for Security & Access → Advanced destinations. The dropdown, URL parsing, Overview links and
 * panel rendering all read this list; there is no second (desktop/mobile) copy.
 *
 * Authorization is NOT decided here: every panel keeps its own server enforcement / informational state. `canView` only
 * hides a destination that a client-side predicate says is unavailable; it can never grant access.
 */
export type AdvancedSection = 'governance' | 'technical' | 'scopes' | 'authority' | 'audit'
export type GovernanceSection = 'requests' | 'delegations' | 'reviews' | 'sod' | 'emergency'
export type AuditSection = 'decisions' | 'changes' | 'parity' | 'simulator'

export interface AdvancedDestination {
  /** Stable option id, e.g. "governance/requests" or "scopes". */
  id: string
  section: AdvancedSection
  gov?: GovernanceSection
  audit?: AuditSection
  /** Category heading (non-selectable); omitted for stand-alone destinations. */
  group?: string
  label: string
  canView?: () => boolean
}

export const ADVANCED_DESTINATIONS: AdvancedDestination[] = [
  { id: 'governance/requests', section: 'governance', gov: 'requests', group: 'Governance', label: 'Access Requests' },
  { id: 'governance/delegations', section: 'governance', gov: 'delegations', group: 'Governance', label: 'Delegations' },
  { id: 'governance/reviews', section: 'governance', gov: 'reviews', group: 'Governance', label: 'Access Reviews' },
  { id: 'governance/sod', section: 'governance', gov: 'sod', group: 'Governance', label: 'Segregation of Duties' },
  { id: 'governance/emergency', section: 'governance', gov: 'emergency', group: 'Governance', label: 'Emergency Access' },
  { id: 'technical', section: 'technical', label: 'Technical Access' },
  { id: 'scopes', section: 'scopes', label: 'Data Scope' },
  { id: 'authority', section: 'authority', label: 'Approval Limits' },
  { id: 'audit/decisions', section: 'audit', audit: 'decisions', group: 'Audit & Diagnostics', label: 'Authorization decisions' },
  { id: 'audit/changes', section: 'audit', audit: 'changes', group: 'Audit & Diagnostics', label: 'Access changes' },
  { id: 'audit/parity', section: 'audit', audit: 'parity', group: 'Audit & Diagnostics', label: 'Parity evidence' },
  { id: 'audit/simulator', section: 'audit', audit: 'simulator', group: 'Audit & Diagnostics', label: 'Access simulator' },
]

export const GOVERNANCE_SECTIONS: GovernanceSection[] = ['requests', 'delegations', 'reviews', 'sod', 'emergency']
export const AUDIT_SECTIONS: AuditSection[] = ['decisions', 'changes', 'parity', 'simulator']

export const visibleDestinations = () => ADVANCED_DESTINATIONS.filter(d => d.canView?.() ?? true)

export function destinationFor(nav: { section: AdvancedSection; gov: GovernanceSection; audit: AuditSection }): AdvancedDestination {
  return ADVANCED_DESTINATIONS.find(d => d.section === nav.section && (d.gov ?? nav.gov) === nav.gov && (d.audit ?? nav.audit) === nav.audit) || ADVANCED_DESTINATIONS[0]
}

export const destinationTitle = (d: AdvancedDestination) => d.group ? `${d.group} / ${d.label}` : d.label
