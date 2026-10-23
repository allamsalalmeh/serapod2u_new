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

  it('marks archived identities with the canonical terminal lifecycle state', () => {
    expect(verifyRoute).toContain('archiveIdentityKeepingIdentifiers(user.id, targetUser.id)')
    // Before enforcement: the historical direct write; once enforced: the database lifecycle function.
    expect(archiveHelper).toContain("account_status: 'ARCHIVED'")
    expect(archiveHelper).toContain("setIdentityAccountStatus(actorId, targetUserId, 'ARCHIVED', reason)")
  })

  it('archives historical users keeping their identifiers reserved (one human = one identity)', () => {
    for (const source of [verifyRoute, archiveHelper]) {
      expect(source).not.toContain('@deleted.serapod.local')
      expect(source).not.toMatch(/email:\s*archived/)
      expect(source).not.toContain('phone: null')
    }
    expect(archiveHelper).toContain("ban_duration: '876000h'")
    expect(archiveHelper).toContain('the real\n * email and phone stay reserved')
    expect(verifyRoute).toContain('email/phone stay reserved')
  })

  it('explains archive behavior instead of reporting a generic failure', () => {
    expect(managementView).toContain('Orders, documents and other business history stay attributed to this person.')
    expect(managementView).toContain('Verify & Archive')
    expect(requestRoute).not.toContain("error: 'Something went wrong'")
    expect(verifyRoute).not.toContain("error: 'Something went wrong'")
  })

  it('falls back through configured channels and keeps org contact as recipient', () => {
    expect(requestRoute).toContain("select('contact_phone, contact_email, org_name')")
    expect(requestRoute).toContain('sendTransactionalOtp')
    expect(requestRoute).toContain('resolveDeleteUserOtpPreset')
    expect(requestRoute).toContain('fallbackUsed')
    expect(managementView).toContain('User Deletion OTP')
    expect(managementView).toContain('Notifications → Types')
  })
})
