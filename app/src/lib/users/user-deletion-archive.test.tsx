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
  it('classifies retained history before removal with the database definition (orders, documents, signatures, Supply Chain, audit)', () => {
    for (const source of [requestRoute, verifyRoute]) {
      expect(source).toContain('identityHistoryReferences(userId)')
      expect(source).toContain("if (references === null) return 'archive'")
      expect(source).toContain("return references.length > 0 ? 'archive' : 'delete'")
    }
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
    expect(managementView).toContain('Users with orders or documents are archived to protect history.')
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
