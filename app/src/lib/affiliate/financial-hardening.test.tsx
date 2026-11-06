import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../../../')
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261225110000_affiliate_program_hardening.sql'),
  'utf8',
)
const adminRoute = fs.readFileSync(path.join(root, 'app/src/app/api/admin/affiliates/route.ts'), 'utf8')

describe('affiliate financial hardening contract', () => {
  it('keeps confirmation strictly beyond the seven-day refund window', () => {
    expect(migration).toContain('CHECK (confirm_after_days BETWEEN 7 AND 180)')
    expect(migration).toContain('greatest(coalesce(v_confirm, 7), 7)')
    expect(migration).toMatch(/delivered_at \+ make_interval\(days => v_confirm\) < now\(\)/)
  })

  it('holds confirmed commissions when a request opens and excludes them from payout', () => {
    expect(migration).toMatch(/SET status = 'pending',[\s\S]*c\.status = 'confirmed'[\s\S]*r\.status IN \('new', 'reviewing', 'approved'\)/)
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.affiliate_record_payout[\s\S]*NOT EXISTS \([\s\S]*storefront_order_requests/)
  })

  it('locks and pays only the exact amount and bank snapshot the approver saw', () => {
    expect(migration).toContain('p_expected_amount numeric')
    expect(migration).toContain('p_expected_bank_account_no text')
    expect(migration).toContain('FOR UPDATE OF c, o')
    expect(migration).toContain('r.order_id = ANY(v_order_ids)')
    expect(migration).toContain('WHERE id = ANY(v_commission_ids)')
    expect(migration).toContain("RAISE EXCEPTION 'affiliate_payout_snapshot_changed'")
    expect(adminRoute).toContain("'finance.payment.approve'")
    expect(adminRoute).toContain('p_expected_amount: expectedAmount')
  })

  it('versions terms atomically in the database', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.affiliate_version_program_terms()')
    expect(migration).toContain('NEW.terms_version := OLD.terms_version + 1')
    expect(adminRoute).not.toContain(".select('terms, terms_version')")
  })

  it('uses complete aggregate RPCs and preserves financial ledger rows', () => {
    const totalsBody = migration.match(/CREATE OR REPLACE FUNCTION public\.affiliate_commission_totals[\s\S]*?\$\$;/)?.[0] || ''
    expect(totalsBody).toContain('GROUP BY c.affiliate_id')
    expect(totalsBody.toLowerCase()).not.toContain('limit ')
    expect(migration).toContain('ON DELETE RESTRICT')
  })

  it('keeps definer functions service-role only with a hardened search path', () => {
    expect((migration.match(/SET search_path = public, pg_temp/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(migration).toContain('FROM public, anon, authenticated')
    expect(migration).toContain('TO service_role')
  })
})
