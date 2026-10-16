/** Shared accent chips for module landing cards (icon background + icon color). */
export type LandingAccent = { chip: string; icon: string }

export const landingAccents = {
  orange: { chip: 'bg-[var(--sera-orange)]/10', icon: 'text-[var(--sera-orange)]' },
  orangeDeep: { chip: 'bg-[var(--sera-orange)]/[0.08]', icon: 'text-[var(--sera-orange-deep)]' },
  sky: { chip: 'bg-sky-50', icon: 'text-sky-600' },
  violet: { chip: 'bg-violet-50', icon: 'text-violet-600' },
  teal: { chip: 'bg-teal-50', icon: 'text-teal-600' },
  emerald: { chip: 'bg-emerald-50', icon: 'text-emerald-700' },
  amber: { chip: 'bg-amber-50', icon: 'text-amber-600' },
  rose: { chip: 'bg-rose-50', icon: 'text-rose-600' },
  indigo: { chip: 'bg-indigo-50', icon: 'text-indigo-600' },
  slate: { chip: 'bg-slate-100', icon: 'text-slate-600' },
  pink: { chip: 'bg-pink-50', icon: 'text-pink-600' },
  cyan: { chip: 'bg-cyan-50', icon: 'text-cyan-600' },
} as const satisfies Record<string, LandingAccent>

export function pickLandingAccent(
  map: Record<string, LandingAccent>,
  id: string,
  fallback: LandingAccent = landingAccents.orange
): LandingAccent {
  return map[id] ?? fallback
}

/** Supply Chain hub cards */
export const supplyChainLandingAccents: Record<string, LandingAccent> = {
  'sc-organizations': landingAccents.sky,
  'sc-products': landingAccents.orange,
  'sc-orders': landingAccents.violet,
  'sc-qr': landingAccents.orangeDeep,
  'sc-inventory': landingAccents.teal,
  'sc-quality': landingAccents.emerald,
}

/** Customer & Growth hub cards */
export const customerGrowthLandingAccents: Record<string, LandingAccent> = {
  'cg-crm': landingAccents.teal,
  'cg-marketing': landingAccents.rose,
  'cg-loyalty': landingAccents.amber,
  'cg-catalog': landingAccents.indigo,
  'cg-ecommerce': landingAccents.violet,
}

/** RoadTour hub cards */
export const roadtourLandingAccents: Record<string, LandingAccent> = {
  'rt-campaigns': landingAccents.orange,
  'rt-reporting': landingAccents.sky,
  'rt-settings': landingAccents.slate,
}

/** CRM hub cards */
export const crmLandingAccents: Record<string, LandingAccent> = {
  'crm-support': landingAccents.teal,
}

/** Marketing hub cards */
export const marketingLandingAccents: Record<string, LandingAccent> = {
  'mkt-campaigns': landingAccents.rose,
}

/** Loyalty hub cards */
export const loyaltyLandingAccents: Record<string, LandingAccent> = {
  'ly-rewards': landingAccents.amber,
}

/** Catalog hub cards */
export const catalogLandingAccents: Record<string, LandingAccent> = {
  'cat-products': landingAccents.indigo,
}

/** HR hub cards */
export const hrLandingAccents: Record<string, LandingAccent> = {
  'hr-people': landingAccents.sky,
  'hr-attendance': landingAccents.teal,
  'hr-leave': landingAccents.violet,
  'hr-payroll': landingAccents.amber,
  'hr-performance': landingAccents.rose,
  'hr-settings': landingAccents.slate,
}

/** Finance hub cards */
export const financeLandingAccents: Record<string, LandingAccent> = {
  'finance-gl': landingAccents.emerald,
  'finance-ar': landingAccents.sky,
  'finance-ap': landingAccents.orange,
  'finance-cash': landingAccents.indigo,
  'finance-reports': landingAccents.violet,
  'finance-settings': landingAccents.slate,
}

/** Settings hub cards */
export const settingsLandingAccents: Record<string, LandingAccent> = {
  'settings-profile': landingAccents.sky,
  'settings-organization': landingAccents.violet,
  'settings-notifications': landingAccents.rose,
  'settings-preferences': landingAccents.teal,
  'settings-authorization': landingAccents.indigo,
  'settings-ai': landingAccents.amber,
  'settings-system': landingAccents.slate,
  'settings-danger-zone': landingAccents.rose,
}
