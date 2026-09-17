import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAdminClientMock = vi.fn()
const checkRegistrationAvailabilityMock = vi.fn()
const checkSendRateLimitMock = vi.fn()
const createVerificationCodeMock = vi.fn()
const generateOtpMock = vi.fn()
const hashOtpMock = vi.fn()
const invalidateExistingCodesMock = vi.fn()
const logNotificationEventMock = vi.fn()
const sendOtpViaEmailMock = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}))

vi.mock('@/server/auth/registrationVerificationService', () => ({
  REGISTRATION_OTP_CHANNEL: 'email',
  RESEND_COOLDOWN_SECONDS: 60,
  checkRegistrationAvailability: checkRegistrationAvailabilityMock,
  checkSendRateLimit: checkSendRateLimitMock,
  createVerificationCode: createVerificationCodeMock,
  generateOtp: generateOtpMock,
  hashOtp: hashOtpMock,
  invalidateExistingCodes: invalidateExistingCodesMock,
  logNotificationEvent: logNotificationEventMock,
  sendOtpViaEmail: sendOtpViaEmailMock,
  deliverRegistrationOtp: sendOtpViaEmailMock,
  resolveRegistrationOtpDelivery: async () => ({ setting: null, channel: 'email' }),
  registrationOtpSentMessage: () => 'sent',
  registrationOtpFailedMessage: () => 'failed',
}))

describe('POST /api/auth/register/request-code', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    createAdminClientMock.mockReturnValue({
      from: (table: string) => {
        if (table === 'organizations') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'shop-1',
                    org_name: 'Kedai Maju',
                    branch: 'HQ',
                    org_type_code: 'SHOP',
                    is_active: true,
                  },
                }),
              }),
            }),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      },
    })
  })

  it('rejects OTP start when no authoritative shop selection is submitted', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/auth/register/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ali@example.com',
        phone: '0123456789',
        fullName: 'Ali',
        orgId: 'org-1',
        referenceUserId: 'ref-1',
        referralPhone: '+60123456789',
        shopName: 'Kedai Maju',
        password: 'secret123',
        confirmPassword: 'secret123',
      }),
    }) as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload).toEqual({
      field: 'shop',
      error: 'Please select a valid shop from the list.',
    })
    expect(checkRegistrationAvailabilityMock).not.toHaveBeenCalled()
    expect(createVerificationCodeMock).not.toHaveBeenCalled()
    expect(sendOtpViaEmailMock).not.toHaveBeenCalled()
  })

  it('rejects OTP start when no authoritative reference selection is submitted', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/auth/register/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ali@example.com',
        phone: '0123456789',
        fullName: 'Ali',
        orgId: 'org-1',
        shopOrganizationId: 'shop-1',
        shopName: 'Kedai Maju (HQ)',
        password: 'secret123',
        confirmPassword: 'secret123',
      }),
    }) as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload).toEqual({
      field: 'reference',
      error: 'Please select a valid reference from the list.',
    })
    expect(checkRegistrationAvailabilityMock).not.toHaveBeenCalled()
    expect(createVerificationCodeMock).not.toHaveBeenCalled()
    expect(sendOtpViaEmailMock).not.toHaveBeenCalled()
  })

  it('rejects OTP start when the password is too short', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/auth/register/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ali@example.com',
        phone: '0123456789',
        fullName: 'Ali',
        orgId: 'org-1',
        password: '12345',
        confirmPassword: '12345',
      }),
    }) as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload).toEqual({
      field: 'password',
      error: 'Password must be at least 6 characters.',
    })
    expect(checkRegistrationAvailabilityMock).not.toHaveBeenCalled()
  })

  it('rejects OTP start when confirm password does not match', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/auth/register/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ali@example.com',
        phone: '0123456789',
        fullName: 'Ali',
        orgId: 'org-1',
        password: 'secret123',
        confirmPassword: 'secret321',
      }),
    }) as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload).toEqual({
      field: 'confirmPassword',
      error: 'Passwords do not match',
    })
    expect(checkRegistrationAvailabilityMock).not.toHaveBeenCalled()
  })
})