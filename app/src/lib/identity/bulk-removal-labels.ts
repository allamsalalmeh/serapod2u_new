import type { BulkRemovalAction, BulkRemovalClassification } from './bulk-removal-plan'

/**
 * Client-safe labels for the bulk removal dialog. Kept apart from
 * bulk-removal-plan.ts so a client component never imports node:crypto.
 */
export const BULK_CLASSIFICATION_LABELS: Record<BulkRemovalClassification, string> = {
  DELETE_ELIGIBLE: 'Eligible for permanent deletion',
  ARCHIVE_ELIGIBLE: 'Archive & revoke access (history kept)',
  BLOCKED: 'Blocked — no removal permitted',
  UNVERIFIED: 'Not verified — nothing can be executed',
}

export const bulkActionLabel = (action: BulkRemovalAction): string =>
  action === 'delete' ? 'Permanent deletion' : 'Archive & Revoke Access'

export const BULK_OUTCOME_LABELS: Record<string, string> = {
  deleted: 'Deleted permanently',
  archived: 'Archived — access revoked',
  blocked: 'Blocked — unchanged',
  conflict: 'Temporary conflict — unchanged',
  failed: 'Failed — not completed',
  stale: 'Changed since preview — unchanged',
  unconfirmed: 'Unconfirmed — check this employee',
}
