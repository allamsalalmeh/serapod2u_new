import { validateEventToken } from '@/modules/event-management/lib/staff-qr'
import { EventRegistrationForm } from '@/modules/event-management/components/EventRegistrationForm'

export const dynamic = 'force-dynamic'

export default async function EventRegistrationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = token ? await validateEventToken(token) : null

  if (!data || data.valid !== true) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7f8f8] p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-[#17283a]">Registration unavailable</h1>
          <p className="mt-2 text-sm text-[#5b6b7c]">
            {data?.status === 'revoked' || data?.status === 'expired' || data?.status === 'event_not_active'
              ? 'This QR code is no longer active.'
              : 'This QR code is invalid.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <EventRegistrationForm
      token={token}
      eventName={data.event_name ?? null}
      brandName={data.brand_name ?? null}
      timezone={data.timezone ?? 'Asia/Kuala_Lumpur'}
      opensAt={data.opens_at ?? null}
      closesAt={data.closes_at ?? null}
      formConfig={data.form_config ?? {}}
    />
  )
}
