import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filterPoliciesForRecipient, isManufacturingOnly, recipientEligibility } from './recipient-eligibility'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from './readiness'

const MIGRATION = resolve(__dirname, '../../../../supabase/migrations/20261012100000_sa_manufacturing_full_access_manufacturer.sql')
const sql = readFileSync(MIGRATION, 'utf8')
const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const seeded = (executable.match(/v_perms constant text\[\] := array\[([^\]]+)\]/)![1].match(/'([^']+)'/g) ?? []).map(k => k.replace(/'/g, ''))

describe('Manufacturing Full Access — Manufacturer (unapplied migration)', () => {
  it('seeds an explicit, Manufacturing-only list without the cross-manufacturer administer permission', () => {
    expect(seeded).toEqual(['manufacturing.adjustment.manage', 'manufacturing.production.manage', 'manufacturing.scan.reverse'])
    expect(isManufacturingOnly(seeded)).toBe(true)
    expect(seeded).not.toContain('manufacturing.adjustment.administer')
    expect(seeded.some(k => /^(finance|hr|security|platform|customer|inventory|qr|product|warehouse|supply_chain)\./.test(k))).toBe(false)
  })
  it('is a published template for the Manufacturer audience only, with no assignment and no mode change', () => {
    expect(executable).toMatch(/'manufacturing-full-access-manufacturer'/)
    expect(executable).toMatch(/'Manufacturing Full Access — Manufacturer'/)
    expect(executable).toMatch(/'template', 'active', array\['partner'\], array\['MFG'\]/)
    expect(executable).not.toMatch(/sa_role_assignments|sa_assignment_scopes|sa_migration_modes|update public\./i)
    expect(executable).toMatch(/on conflict \(role_key\) do nothing/)
  })
  it('every seeded key is a registered permission', () => {
    for (const k of seeded) expect(ALL_ENFORCEMENT_READY_PERMISSIONS, k).toContain(k)
  })
  it('is offered to Manufacturer accounts and nobody else', () => {
    const policy = { roleKey: 'manufacturing-full-access-manufacturer', status: 'active', source: 'template', accountTypes: ['partner'], orgTypes: ['MFG'], permissionKeys: seeded }
    expect(recipientEligibility(policy, 'MFG')).toEqual({ ok: true })
    // Organization-type eligibility (20261030100000): a Manufacturer-only policy is never granted to an HQ membership.
    expect(recipientEligibility(policy, 'HQ')).toMatchObject({ ok: false, code: 'ORG_TYPE_NOT_ELIGIBLE' })
    expect(recipientEligibility(policy, 'DIST')).toMatchObject({ ok: false })
    // Before that migration the database still applied its old account-type rule, which also refused partner-only policies for HQ.
    expect(recipientEligibility(policy, 'HQ', 'legacy')).toMatchObject({ ok: false })
    const internalOnly = { ...policy, roleKey: 'supply-chain-full-access', accountTypes: ['internal'], orgTypes: [] as string[], permissionKeys: [...seeded, 'inventory.transfer.view'] }
    const administer = { ...policy, roleKey: 'adjustment-administrator', accountTypes: [] as string[], orgTypes: [] as string[], permissionKeys: ['manufacturing.adjustment.administer'] }
    const finance = { ...policy, roleKey: 'finance-full-access', accountTypes: ['internal'], orgTypes: [] as string[], permissionKeys: ['finance.ledger.view'] }
    expect(filterPoliciesForRecipient([policy, internalOnly, administer, finance], 'MFG')).toEqual([policy])
  })
})
