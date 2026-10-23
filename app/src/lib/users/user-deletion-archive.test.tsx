import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const requestRoute = fs.readFileSync(
  path.join(root, 'src/app/api/admin/delete-user-otp/request/route.ts'),
  'utf8',
)
const verifyRoute = fs.readFileSync(
  path.join(root, 'src/app/api/admin/delete-user-otp/verify-and-delete/route.ts'),
  'utf8',
)
// The archive write is shared by every removal path (Archive Identities, platform.identity.delete).
const archiveHelper = fs.readFileSync(
  path.join(root, 'src/lib/identity/removal-authorization.ts'),
  'utf8',
)
const archiveMigration = fs.readFileSync(
  path.join(root, '../supabase/migrations/20261217100000_identity_archive_identifier_release.sql'),
  'utf8',
)
const archiveDialog = fs.readFileSync(
  path.join(root, 'src/components/identity/ArchiveIdentityDialog.tsx'),
  'utf8',
)
const managementView = fs.readFileSync(
  path.join(root, 'src/components/users/UserManagementNew.tsx'),
  'utf8',
)

describe('user deletion archive-and-release safety contract', () => {
  it('the OTP flow only archives; permanent deletion is the canonical identity deletion shared with HR', () => {
    for (const source of [requestRoute, verifyRoute]) {
      expect(source).not.toContain("removalMode = await getUserRemovalMode")
      expect(source).toContain('/api/identity/permanent-delete')
    }
    expect(verifyRoute).not.toContain("from('users').delete()")
    expect(verifyRoute).not.toMatch(/from\('audit_logs'\)\.delete\(\)/)
    expect(verifyRoute).not.toMatch(/auth\.admin\.deleteUser/)
    expect(managementView).toContain('<PermanentDeleteDialog')
    expect(managementView).toContain('entry="user_management"')
  })

  it('marks archived identities with the canonical terminal lifecycle state, in one database transaction', () => {
    expect(verifyRoute).toContain('archiveIdentityKeepingIdentifiers(user.id, targetUser.id)')
    expect(archiveHelper).toContain('archiveExecute({')
    expect(archiveHelper).not.toMatch(/account_status: 'ARCHIVED'/)
    expect(archiveMigration).toContain("perform public.identity_set_account_status(p_actor, p_user, 'ARCHIVED', btrim(p_reason));")
    expect(archiveMigration).toContain('v_login := public.identity_revoke_login(p_user);')
  })

  it('archive keeps identifiers reserved; only an explicit release frees them (originals kept in a restricted snapshot)', () => {
    for (const source of [verifyRoute, archiveHelper]) {
      expect(source).not.toContain('@deleted.serapod.local')
      expect(source).not.toMatch(/email:\s*archived/)
      expect(source).not.toContain('phone: null')
    }
    expect(archiveHelper).toContain('releaseIdentifiers: false')
    expect(verifyRoute).toContain('email/phone stay reserved')
    expect(archiveMigration).toContain("'archived+' || replace(p_user::text, '-', '') || '@released.invalid'")
    expect(archiveMigration).toContain('insert into public.identity_identifier_releases(user_id, email, email_normalized, phone, released_by, reason, request_id)')
  })

  it('a released email/phone stops Add User for an explicit same-person / different-person decision', () => {
    expect(managementView).toContain('(result as any).code === "IDENTITY_PREVIOUSLY_RELEASED"')
    expect(managementView).toContain('released_identifier_decision: "new_person"')
    expect(managementView).toContain('Same person — show archived users')
    // archived users are excluded from the default (current) list and totals
    expect(managementView).toContain('useState<"active" | "archived" | "all">("active")')
    expect(managementView).toContain('const matchesLifecycle = lifecycleView === "all" || (lifecycleView === "archived" ? archived : !archived);')
  })

  it('explains archive behavior instead of reporting a generic failure', () => {
    expect(managementView).toContain('<ArchiveIdentityDialog')
    expect(managementView).toContain('Archived (former) users')
    expect(archiveDialog).toContain('This is not a deletion.')
    expect(requestRoute).not.toContain("error: 'Something went wrong'")
    expect(verifyRoute).not.toContain("error: 'Something went wrong'")
  })

  it('falls back through configured channels and keeps org contact as recipient', () => {
    expect(requestRoute).toContain("select('contact_phone, contact_email, org_name')")
    expect(requestRoute).toContain('sendTransactionalOtp')
    expect(requestRoute).toContain('resolveDeleteUserOtpPreset')
    expect(requestRoute).toContain('fallbackUsed')
  })
})
