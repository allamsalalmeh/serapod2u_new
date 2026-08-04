import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string) => fs.readFileSync(
  new URL(`../../../../${path}`, import.meta.url),
  'utf8',
)

const phaseA = repoFile('supabase/deployment/20260804_stock_count_v2_final/00_PhaseA_inspect_counting_cutoff.sql')
const phaseB = repoFile('supabase/deployment/20260804_stock_count_v2_final/00_PhaseB_cancel_counting_cutoff.sql')
const phaseC = repoFile('supabase/deployment/20260804_stock_count_v2_final/00_PhaseC_verify_counting_cutoff.sql')
const cleanup = [phaseA, phaseB, phaseC].join('\n')
const preflight = repoFile('supabase/deployment/20260804_stock_count_v2_final/01_preflight_read_only.sql')
const recon = [
  repoFile('supabase/deployment/20260804_stock_count_v2_final/06_PhaseA_reconciliation_preview.sql'),
  repoFile('supabase/deployment/20260804_stock_count_v2_final/06_PhaseB_reconciliation_apply.sql'),
].join('\n')
const packFiles = [
  '00_PhaseA_inspect_counting_cutoff.sql', '00_PhaseB_cancel_counting_cutoff.sql',
  '00_PhaseC_verify_counting_cutoff.sql', '01_preflight_read_only.sql',
  '02_schema_foundation.sql', '03_constraints_and_indexes.sql',
  '04_functions_and_triggers.sql', '05_rls_policies_and_grants.sql',
  '06_PhaseA_reconciliation_preview.sql', '06_PhaseB_reconciliation_apply.sql',
  '07_final_contract_fixes.sql', '08_post_deployment_verification.sql',
  '09_operational_smoke_checks_read_only.sql',
].map(f => [f, repoFile(`supabase/deployment/20260804_stock_count_v2_final/${f}`)] as const)

// The cleanup script is a one-off production repair for a stranded Opening
// Balance cut-off left in status 'counting'. It runs by hand against live data,
// so its safety contract is asserted here rather than trusted to review.
describe('00_PhaseA/B/C counting-cutoff cleanup safety contract', () => {
  it('PHASE A and PHASE C are read-only transactions', () => {
    const readOnlyBegins = cleanup.match(/BEGIN READ ONLY;/g) || []
    expect(readOnlyBegins.length).toBe(2)
    expect(cleanup).toContain('SET default_transaction_read_only = on;')
  })

  it('PHASE A emits an explicit, reviewable decision', () => {
    expect(cleanup).toContain('SAFE_TO_CANCEL_OR_CLEAN')
    expect(cleanup).toContain('NOT_SAFE')
    expect(cleanup).toContain('REVIEW_REQUIRED')
  })

  it('never performs a broad write keyed only on status', () => {
    // Any UPDATE/DELETE must be keyed on the exact primary key. A write whose
    // only predicate is the status would hit every stranded cut-off at once.
    // Strip `--` comments first: the file documents the rule in prose, and the
    // prose must not be mistaken for a statement.
    const code = cleanup
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n')
    const writes = code.match(/\b(UPDATE|DELETE FROM)\s+public\.[\s\S]*?;/gi) || []
    expect(writes.length).toBeGreaterThan(0)
    for (const stmt of writes) {
      if (!/\bWHERE\b/i.test(stmt)) {
        throw new Error(`unconditional write found: ${stmt.slice(0, 80)}`)
      }
      const where = stmt.slice(stmt.search(/\bWHERE\b/i))
      // Every real write targets an explicit id (the cut-off, or its one session).
      expect(where).toMatch(/\bid\s*=\s*(p\.target_cutoff_id|v_session\.id)|session_id\s*=\s*v_session\.id/)
    }
  })

  it('refuses to act until the operator pastes a real target and actor', () => {
    expect(cleanup).toContain('PHASE B not armed')
    const placeholders = cleanup.match(/'00000000-0000-0000-0000-000000000000'::uuid/g) || []
    // one for the cut-off, one for the acting admin, plus their two guards
    expect(placeholders.length).toBeGreaterThanOrEqual(4)
  })

  it('fails closed unless exactly one cut-off matches id AND expected status', () => {
    expect(cleanup).toContain('expected exactly 1 cut-off with id=% and status=%')
    expect(cleanup).toContain('IF v_match_count <> 1 THEN')
    expect(cleanup).toContain('FOR UPDATE')
  })

  it('blocks on every form of posting evidence', () => {
    expect(cleanup).toContain('carries a posted marker')
    expect(cleanup).toContain('report row(s) exist for this cut-off')
    expect(cleanup).toContain('posting-context row(s) exist')
    expect(cleanup).toContain('verification request(s) show final posting was started')
    expect(cleanup).toContain('stock_movements reference this session')
    expect(cleanup).toContain('opening-balance-tagged movements exist')
  })

  it('prefers the official cancellation RPC over hand-written mutation', () => {
    expect(cleanup).toContain("to_regprocedure('public.cancel_inventory_opening_cutoff(uuid, text)')")
    expect(cleanup).toContain('PERFORM public.cancel_inventory_opening_cutoff(')
  })

  it('cancels rather than physically deleting the cut-off', () => {
    expect(cleanup).toMatch(/SET\s+status\s*=\s*'cancelled'/)
    expect(cleanup).not.toMatch(/delete\s+from\s+public\.inventory_opening_cutoffs/i)
  })

  it('never writes inventory, movements, orders or QR data', () => {
    expect(cleanup).not.toMatch(/\bUPDATE\s+public\.product_inventory\b/i)
    expect(cleanup).not.toMatch(/\bDELETE\s+FROM\s+public\.product_inventory\b/i)
    expect(cleanup).not.toMatch(/\bUPDATE\s+public\.stock_movements\b/i)
    expect(cleanup).not.toMatch(/\bDELETE\s+FROM\s+public\.stock_movements\b/i)
    expect(cleanup).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+public\.orders\b/i)
    expect(cleanup).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+public\.order_items\b/i)
    expect(cleanup).not.toMatch(/\bqr_/i)
  })

  it('proves inventory and movements were untouched before committing', () => {
    expect(cleanup).toContain('ABORT: product_inventory changed')
    expect(cleanup).toContain('ABORT: stock_movements changed')
    expect(cleanup).toContain('product_inventory UNCHANGED')
    expect(cleanup).toContain('stock_movements UNCHANGED')
  })

  it('ends the first execution in ROLLBACK with COMMIT left commented out', () => {
    expect(cleanup).toMatch(/^ROLLBACK;$/m)
    expect(cleanup).toMatch(/^-- COMMIT;$/m)
  })

  it('does not depend on tables introduced by 02 (probes them instead)', () => {
    expect(cleanup).toContain("to_regclass('public.' || v_tbl)")
    expect(cleanup).toContain('table absent on this database')
    // The 02-only tables must never appear as a static reference, or the file
    // would fail to parse on the current production schema.
    for (const table of [
      'inventory_cutoff_d2h_policies',
      'inventory_cutoff_h2m_policies',
      'inventory_cutoff_transactions_policies',
      'inventory_cutoff_allocation_requests',
    ]) {
      expect(cleanup).not.toMatch(new RegExp(`FROM\\s+public\\.${table}\\b`, 'i'))
    }
  })

  it('archives the draft session only after the cut-off is cancelled', () => {
    // Ordering matters: stock_count_discard_posting_started_guard blocks
    // draft -> archived while the cut-off is still 'counting'.
    const cancelAt = cleanup.search(/SET\s+status\s*=\s*'cancelled'/)
    const archiveAt = cleanup.search(/SET\s+status\s*=\s*'archived'/)
    expect(cancelAt).toBeGreaterThan(-1)
    expect(archiveAt).toBeGreaterThan(cancelAt)
  })
})

describe('01_preflight_read_only.sql keeps the active cut-off blocker', () => {
  it('still reports REVIEW_REQUIRED for any counting cut-off', () => {
    expect(preflight).toContain(
      "CASE WHEN count(*) FILTER (WHERE c.status='counting') = 0 THEN 'PASS' ELSE 'REVIEW_REQUIRED' END",
    )
  })

  it('distinguishes a live count from a stranded one without weakening the gate', () => {
    expect(preflight).toContain('session draft: ')
    expect(preflight).toContain('session archived (stranded): ')
    expect(preflight).toContain('session missing: ')
    expect(preflight).toContain('OTP requested: ')
  })

  it('lists in-progress cut-off ids as INFO so counts are unaffected', () => {
    expect(preflight).toContain('in-progress cut-off ids (for 00_PhaseA)')
    // INFO never feeds FAIL_COUNT or REVIEW_REQUIRED_COUNT.
    expect(preflight).toContain("WHERE status='FAIL'")
    expect(preflight).toContain("WHERE status='REVIEW_REQUIRED'")
  })
})

// 06 is the only pack file that changes business data. Its opt-in used to be a
// psql `\if` block, which silently stopped protecting the UPDATEs in any client
// that does not parse backslash meta-commands.
describe('06_PhaseA/B reconciliation safety contract', () => {
  it('no pack file uses psql backslash meta-commands', () => {
    for (const [name, body] of packFiles) {
      const meta = body.split('\n').filter(l => /^\s*\\[a-z]/i.test(l))
      expect(meta, `${name} contains psql meta-commands: ${meta.join(' | ')}`).toEqual([])
    }
  })

  it('the preview is read-only and emits a decision', () => {
    expect(recon).toContain('BEGIN READ ONLY;')
    expect(recon).toContain('SAFE_TO_APPLY')
    expect(recon).toContain('NOT_SAFE')
    expect(recon).toContain('NOTHING_TO_DO')
  })

  it('apply refuses while ambiguities are non-zero unless overridden', () => {
    expect(recon).toContain('Refusing to apply')
    expect(recon).toContain('ambiguity_override')
    expect(recon).toContain('SELECT false AS ambiguity_override;')
  })

  it('apply asserts the affected row count matches the preview predicate', () => {
    expect(recon).toContain('ABORT: CHANGE 1 updated % row(s) but % were expected')
    expect(recon).toContain('ABORT: CHANGE 2 updated % row(s) but % were expected')
  })

  it('apply proves inventory and movements were untouched', () => {
    expect(recon).toContain('ABORT: product_inventory changed')
    expect(recon).toContain('ABORT: stock_movements changed')
  })

  it('apply defaults to ROLLBACK', () => {
    const applyFile = repoFile('supabase/deployment/20260804_stock_count_v2_final/06_PhaseB_reconciliation_apply.sql')
    expect(applyFile).toMatch(/^ROLLBACK;$/m)
    expect(applyFile).toMatch(/^-- COMMIT;$/m)
  })

  it('CHANGE 2 preview predicate matches its UPDATE predicate', () => {
    // The old file's preview omitted the NOT EXISTS guard and could overcount.
    const notExists = recon.match(/NOT EXISTS \(SELECT 1 FROM public\.inventory_opening_cutoffs/gi) || []
    expect(notExists.length).toBeGreaterThanOrEqual(3)
  })
})
