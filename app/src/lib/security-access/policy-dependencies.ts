import { ORDER_VIEW_PERMISSION } from './order-view'

/**
 * Supporting read permissions: an operation that cannot be used without reading what it acts on (an approver opens the
 * order it approves). Mirrors public.sa_permission_dependencies (20261101100000); order-view.test.ts keeps them equal.
 *
 * Declarative only. No authorization decision consults this list and a custom policy is never broadened by it: a
 * standard Group Policy includes its supporting reads EXPLICITLY in its permission mapping (a reviewed migration), and
 * the UI uses this list to explain why a read permission is part of a policy.
 */
export const SUPPORTING_READS: Readonly<Record<string, readonly string[]>> = {
  'supply_chain.order.approve': [ORDER_VIEW_PERMISSION],
  'supply_chain.order.create': [ORDER_VIEW_PERMISSION],
  'supply_chain.order.cancel': [ORDER_VIEW_PERMISSION],
}

/** For each permission of a policy that is a supporting read of another permission in it: the operations it supports. */
export function supportingReadsIn(permissionKeys: readonly string[]): Map<string, string[]> {
  const held = new Set(permissionKeys)
  const result = new Map<string, string[]>()
  for (const [operation, reads] of Object.entries(SUPPORTING_READS)) {
    if (!held.has(operation)) continue
    for (const read of reads) {
      if (held.has(read)) result.set(read, [...(result.get(read) ?? []), operation])
    }
  }
  return result
}

/** Declared supporting reads a policy's operations need but the policy does not include (operation → missing reads). */
export function missingSupportingReads(permissionKeys: readonly string[]): Map<string, string[]> {
  const held = new Set(permissionKeys)
  const result = new Map<string, string[]>()
  for (const [operation, reads] of Object.entries(SUPPORTING_READS)) {
    if (!held.has(operation)) continue
    const missing = reads.filter(read => !held.has(read))
    if (missing.length) result.set(operation, missing)
  }
  return result
}
