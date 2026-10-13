import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isResumableOpeningBalanceDraft,
  resolveActiveOpeningBalanceDraft,
} from './opening-balance-active-draft'

const repoFile = (path: string) => fs.readFileSync(
  new URL(`../../../../${path}`, import.meta.url),
  'utf8',
)

const stockCountView = repoFile('app/src/components/inventory/StockAdjustmentView.tsx')
const conflictMigration = repoFile('supabase/migrations/20260730_stock_count_session_items_full_conflict_index.sql')
const configMigration = repoFile('supabase/migrations/20260717_stock_config_04_stock_count.sql')
// Schema snapshots are local-only (kept out of git on purpose), so their assertion runs only where both exist.
const optionalRepoFile = (path: string) => { try { return repoFile(path) } catch { return null } }
const currentSchema = optionalRepoFile('supabase/schemas/current_schema.sql')
const currentStagingSchema = optionalRepoFile('supabase/schemas/current_schema_stg.sql')

describe('Opening Balance Save Draft — item upsert ON CONFLICT constraint', () => {
  it('the item upsert targets (session_id, stock_config_id)', () => {
    // The exact conflict target that must be inferrable by PostgreSQL.
    expect(stockCountView).toContain("onConflict: 'session_id,stock_config_id'")
  })

  it('the original config migration ships only a PARTIAL index that cannot be inferred', () => {
    // Root cause: this partial predicate is why ON CONFLICT inference fails.
    expect(configMigration).toMatch(
      /stock_count_session_items_unique_config[\s\S]*\(session_id, stock_config_id\)[\s\S]*WHERE stock_config_id IS NOT NULL/,
    )
  })

  it('adds a forward-only, idempotent, NON-partial unique index matching the conflict target', () => {
    expect(conflictMigration).toContain('BEGIN;')
    expect(conflictMigration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(conflictMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS stock_count_session_items_session_config_unique_full',
    )
    expect(conflictMigration).toContain('ON public.stock_count_session_items (session_id, stock_config_id)')
    // Must be NON-partial so ON CONFLICT with no predicate can infer it.
    const createStatement = conflictMigration.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS stock_count_session_items_session_config_unique_full[\s\S]*?;/,
    )?.[0] || ''
    expect(createStatement).not.toMatch(/WHERE/i)
  })

  it('fails safely instead of silently rewriting duplicate historical item rows', () => {
    expect(conflictMigration).toMatch(
      /IF EXISTS \([\s\S]*GROUP BY session_id, stock_config_id[\s\S]*HAVING count\(\*\) > 1/,
    )
    expect(conflictMigration).toContain('RAISE EXCEPTION')
    expect(conflictMigration).not.toMatch(/\bDELETE\s+FROM\s+public\.stock_count_session_items/i)
  })

  it.skipIf(!currentSchema || !currentStagingSchema)('is represented as the same full unique contract in both local schema snapshots', () => {
    const expectedIndex =
      'CREATE UNIQUE INDEX stock_count_session_items_session_config_unique_full ON public.stock_count_session_items USING btree (session_id, stock_config_id);'
    expect(currentSchema).toContain(expectedIndex)
    expect(currentStagingSchema).toContain(expectedIndex)
  })

  it('is a narrow, session-scoped key — it does not drop the partial index or widen the key', () => {
    // Keeping the partial index avoids ambiguity (ON CONFLICT infers only the
    // non-partial one) and the key stays scoped per session, so warehouses,
    // categories, count types and configurations can never be merged.
    expect(conflictMigration).not.toMatch(/DROP\s+INDEX/i)
    expect(conflictMigration).not.toMatch(/warehouse_organization_id/i)
    expect(conflictMigration).not.toMatch(/product_category_id/i)
    expect(conflictMigration).not.toMatch(/count_type/i)
  })
})

describe('Opening Balance Save Draft — existing-draft state gating', () => {
  it('tracks a draft-loading state used to gate detection', () => {
    expect(stockCountView).toContain('const [draftsLoading, setDraftsLoading] = useState(false)')
    expect(stockCountView).toContain('setDraftsLoading(true)')
    expect(stockCountView).toContain('setDraftsLoading(false)')
  })

  it('disables Save while existing-draft detection is still loading', () => {
    expect(stockCountView).toContain('const openingDraftDetectionPending = Boolean(')
    expect(stockCountView).toContain('&& !openingDraftDetectionPending')
    // Button is disabled and shows the checking label while pending.
    expect(stockCountView).toContain('disabled={!canSave || saving || openingDraftDetectionPending}')
    expect(stockCountView).toContain('Checking for existing draft…')
  })

  it('invalidates detection immediately whenever its effective warehouse/category changes', () => {
    expect(stockCountView).toContain(
      "const draftCriteriaKey = `${selectedWarehouse}:${isOpeningBalanceMode ? selectedCategory : '*'}`",
    )
    expect(stockCountView).toContain('loadedDraftCriteria !== draftCriteriaKey')
    expect(stockCountView).toContain('}, [draftCriteriaKey])')
  })

  it('does not allow an older draft request to publish over the latest criteria', () => {
    expect(stockCountView).toContain('const generation = ++draftLoadGenerationRef.current')
    expect(stockCountView).toContain('if (generation !== draftLoadGenerationRef.current) return false')
    const publishBlock = stockCountView.slice(
      stockCountView.indexOf('// A warehouse/category change can start a newer request'),
      stockCountView.indexOf('const loadCountRows = async'),
    )
    expect(publishBlock.indexOf('generation !== draftLoadGenerationRef.current'))
      .toBeLessThan(publishBlock.indexOf('setDrafts(nextDrafts)'))
    expect(stockCountView).toContain(
      'if (generation === draftLoadGenerationRef.current) setDraftsLoading(false)',
    )
    expect(stockCountView).toContain(
      'const criteriaDrafts = loadedDraftCriteria === draftCriteriaKey ? drafts : []',
    )
    // Warehouse/category scoping of the active-draft decision was refactored out
    // of an inline `draft.warehouse_organization_id === selectedWarehouse` filter
    // into the authoritative resolver. Assert the wiring passes BOTH the selected
    // warehouse and category (behaviour is proven below via the resolver itself),
    // rather than scanning for a specific inline expression.
    expect(stockCountView).toMatch(
      /resolveActiveOpeningBalanceDraft\(\s*criteriaDrafts,\s*selectedWarehouse,\s*selectedCategory,/,
    )
  })

  it('resolves the active-draft conflict only within the same warehouse, org and category scope', () => {
    // Behavioural regression for the rule the moved-out inline scan protected:
    // the conflict decision must not cross warehouse or product-category scope.
    const drafts = [
      { id: 'wh1-vape', status: 'draft', count_type: 'opening_balance_cutoff', warehouse_organization_id: 'wh-1', product_category_id: 'cat-vape', cutoff_status: null },
      { id: 'wh1-pet', status: 'draft', count_type: 'opening_balance_cutoff', warehouse_organization_id: 'wh-1', product_category_id: 'cat-pet', cutoff_status: null },
      { id: 'wh2-vape', status: 'draft', count_type: 'opening_balance_cutoff', warehouse_organization_id: 'wh-2', product_category_id: 'cat-vape', cutoff_status: null },
    ]
    // Exact warehouse+category match wins; other scopes never conflict.
    expect(resolveActiveOpeningBalanceDraft(drafts, 'wh-1', 'cat-vape')?.id).toBe('wh1-vape')
    expect(resolveActiveOpeningBalanceDraft(drafts, 'wh-1', 'cat-pet')?.id).toBe('wh1-pet')
    expect(resolveActiveOpeningBalanceDraft(drafts, 'wh-2', 'cat-vape')?.id).toBe('wh2-vape')
    // A warehouse/category with no matching draft has no conflict.
    expect(resolveActiveOpeningBalanceDraft(drafts, 'wh-2', 'cat-pet')).toBeUndefined()
    // The exercise being edited is never counted as a conflict against itself.
    expect(resolveActiveOpeningBalanceDraft(drafts, 'wh-1', 'cat-vape', 'wh1-vape')).toBeUndefined()
  })

  it('never treats a posted, cancelled or archived exercise as an active conflict', () => {
    // Posted/cancelled/deleted/archived exercises must not block a new flow.
    expect(isResumableOpeningBalanceDraft({ status: 'draft', count_type: 'opening_balance_cutoff', cutoff_status: 'posted' })).toBe(false)
    expect(isResumableOpeningBalanceDraft({ status: 'draft', count_type: 'opening_balance_cutoff', cutoff_status: 'cancelled' })).toBe(false)
    expect(isResumableOpeningBalanceDraft({ status: 'archived', count_type: 'opening_balance_cutoff', cutoff_status: null })).toBe(false)
    // A genuine active draft (no cutoff yet, or a counting freeze) is a conflict.
    expect(isResumableOpeningBalanceDraft({ status: 'draft', count_type: 'opening_balance_cutoff', cutoff_status: null })).toBe(true)
    expect(isResumableOpeningBalanceDraft({ status: 'draft', count_type: 'opening_balance_cutoff', cutoff_status: 'counting' })).toBe(true)
  })

  it('keeps Save disabled when a known existing Opening Balance draft is found', () => {
    expect(stockCountView).toContain('&& !mustContinueExistingOpeningDraft')
    expect(stockCountView).toContain('An Opening Balance draft already exists for this warehouse')
    expect(stockCountView).toContain('Continue Existing Draft')
  })

  it('keeps Continue Existing Draft wired to the immutable saved session', () => {
    expect(stockCountView).toContain(
      '<Button size="sm" onClick={() => void loadDraft(existingOpeningDraft.id)}>Continue Existing Draft</Button>',
    )
  })

  it('shows a friendly message (never a raw DB error) if Save is clicked before continuing', () => {
    expect(stockCountView).toContain('An active Opening Balance draft already exists')
    expect(stockCountView).toContain('Continue the existing draft before saving.')
  })

  it('labels the button Update Draft once an existing Opening Balance draft is loaded', () => {
    expect(stockCountView).toContain("isOpeningBalanceMode && currentSessionId ? 'Update Draft'")
  })

  it('the friendly guards run inside saveDraft before any session insert/upsert', () => {
    const saveDraftBody = stockCountView.slice(
      stockCountView.indexOf('const saveDraft = async'),
      stockCountView.indexOf("from('stock_count_sessions' as any).insert"),
    )
    expect(saveDraftBody).toContain('if (openingDraftDetectionPending) {')
    expect(saveDraftBody).toContain('if (mustContinueExistingOpeningDraft) {')
  })

  it('performs a final authoritative conflict check and never auto-opens a winning draft', () => {
    const defensiveCheck = stockCountView.slice(
      stockCountView.indexOf('// UI gating is advisory only.'),
      stockCountView.indexOf("from('stock_count_sessions' as any).insert"),
    )
    expect(defensiveCheck).toContain(".eq('warehouse_organization_id', selectedWarehouse)")
    expect(defensiveCheck).toContain(".eq('product_category_id', selectedCategory)")
    expect(defensiveCheck).toContain(".eq('count_type', 'opening_balance_cutoff')")
    expect(defensiveCheck).toContain(".eq('status', 'draft')")
    expect(defensiveCheck).toContain('Use Continue Existing Draft.')
    expect(defensiveCheck).not.toContain('loadDraft(')
  })
})
