'use client'

import { useState, type FormEvent } from 'react'
import { isValidMalaysianPhone } from '@/utils/phone'
import type { EventFormConfig } from '@/modules/event-management/types/event'

const ELLBOW_CAT = '/images/ellbow-mobile-ready-assets/webp/01-ellbow-cat-mascot-full.webp'

interface Props {
  token: string
  eventName: string | null
  brandName: string | null
  timezone: string
  opensAt: string | null
  closesAt: string | null
  formConfig: EventFormConfig
}

export function EventRegistrationForm({ token, eventName, brandName, formConfig }: Props) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [catName, setCatName] = useState('')
  const [catBreed, setCatBreed] = useState('')
  const [currentCatFood, setCurrentCatFood] = useState('')
  const [marketingConsent, setMarketingConsent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const showEmail = formConfig.fields?.email !== 'hidden'
  const showCatName = formConfig.fields?.cat_name !== 'hidden'
  const showCatBreed = formConfig.fields?.cat_breed !== 'hidden'
  const showCurrentCatFood = formConfig.fields?.current_cat_food !== 'hidden'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) return setError('Please enter your name.')
    if (!isValidMalaysianPhone(phone)) return setError('Please enter a valid Malaysian mobile number.')

    setSubmitting(true)
    try {
      const res = await fetch('/api/event-management/public/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          name,
          phone,
          email: email || undefined,
          cat_name: catName || undefined,
          cat_breed: catBreed || undefined,
          current_cat_food: currentCatFood || undefined,
          marketing_consent: marketingConsent,
        }),
      })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || 'Something went wrong. Please try again.')
        return
      }
      setConfirmed(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (confirmed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7f8f8] p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <img src={ELLBOW_CAT} alt="" className="mx-auto h-20 w-20 object-contain" />
          <h1 className="mt-4 text-xl font-semibold text-[#17283a]">You&apos;re registered!</h1>
          <p className="mt-2 text-sm text-[#5b6b7c]">
            Thank you{eventName ? ` for joining ${eventName}` : ''}. See you at the event!
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f7f8f8]">
      <div className="mx-auto max-w-md px-4 py-8">
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="bg-gradient-to-br from-[#087d78] to-[#0b9790] px-6 py-6 text-center">
            <img src={ELLBOW_CAT} alt="" className="mx-auto h-16 w-16 object-contain" />
            <h1 className="mt-2 text-lg font-semibold text-white">{eventName ?? 'Event Registration'}</h1>
            {brandName ? <p className="text-sm text-white/80">{brandName}</p> : null}
          </div>

          <form onSubmit={onSubmit} className="space-y-4 px-6 py-6">
            <div>
              <label className="block text-sm font-medium text-[#17283a]">Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0b9790] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[#17283a]">Mobile phone *</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                placeholder="01x-xxxxxxx"
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0b9790] focus:outline-none"
              />
            </div>

            {showEmail ? (
              <div>
                <label className="block text-sm font-medium text-[#17283a]">Email (optional)</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  inputMode="email"
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0b9790] focus:outline-none"
                />
              </div>
            ) : null}

            {showCatName ? (
              <div>
                <label className="block text-sm font-medium text-[#17283a]">Cat name (optional)</label>
                <input
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  placeholder="Your cat's name"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0b9790] focus:outline-none"
                />
              </div>
            ) : null}

            {showCatBreed ? (
              <div>
                <label className="block text-sm font-medium text-[#17283a]">Cat breed (optional)</label>
                <input
                  value={catBreed}
                  onChange={(e) => setCatBreed(e.target.value)}
                  placeholder="e.g. Persian, Mixed, Tidak pasti"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0b9790] focus:outline-none"
                />
              </div>
            ) : null}

            {showCurrentCatFood ? (
              <div>
                <label className="block text-sm font-medium text-[#17283a]">Current cat food (optional)</label>
                <input
                  value={currentCatFood}
                  onChange={(e) => setCurrentCatFood(e.target.value)}
                  placeholder="What does your cat eat now?"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0b9790] focus:outline-none"
                />
              </div>
            ) : null}

            <label className="flex items-start gap-2 text-sm text-[#5b6b7c]">
              <input
                type="checkbox"
                checked={marketingConsent}
                onChange={(e) => setMarketingConsent(e.target.checked)}
                className="mt-0.5"
              />
              <span>{formConfig.marketing_consent_text ?? 'I agree to receive marketing updates from this brand.'}</span>
            </label>

            {error ? <p className="text-sm font-medium text-[#d44368]">{error}</p> : null}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-[#0b9790] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#087d78] disabled:opacity-60"
            >
              {submitting ? 'Submitting…' : 'Register'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
