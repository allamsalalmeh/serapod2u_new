// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventRegistrationForm } from './EventRegistrationForm'

const PROPS = {
  token: 'tok',
  eventName: 'Ellbow Launch',
  brandName: 'Ellbow',
  timezone: 'Asia/Kuala_Lumpur',
  opensAt: '2026-01-01T00:00:00Z',
  closesAt: '2026-02-01T00:00:00Z',
  formConfig: {
    fields: { email: 'optional' as const, cat_name: 'optional' as const, cat_breed: 'optional' as const, current_cat_food: 'optional' as const },
    marketing_consent_text: 'I agree to receive marketing updates.',
  },
}

describe('EventRegistrationForm (public mobile form, synthetic fixtures)', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the Ellbow-branded header and mandatory fields, and never preselects consent', () => {
    render(<EventRegistrationForm {...PROPS} />)

    expect(screen.getByText('Ellbow Launch')).toBeTruthy()
    expect(screen.getByText('Ellbow')).toBeTruthy()
    expect(screen.getByText('Name *')).toBeTruthy()
    expect(screen.getByText('Mobile phone *')).toBeTruthy()
    expect(screen.getByPlaceholderText('Your name')).toBeTruthy()
    expect(screen.getByPlaceholderText('01x-xxxxxxx')).toBeTruthy()

    // Marketing consent is optional and never preselected.
    const consent = screen.getByRole('checkbox') as HTMLInputElement
    expect(consent.checked).toBe(false)

    // Ellbow cat mascot asset is reused (verified path).
    const img = document.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/images/ellbow-mobile-ready-assets/webp/01-ellbow-cat-mascot-full.webp')
  })

  it('submits and shows a generic confirmation without echoing personal data', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ confirmed: true }) })

    render(<EventRegistrationForm {...PROPS} />)
    fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Amir' } })
    fireEvent.change(screen.getByPlaceholderText('01x-xxxxxxx'), { target: { value: '0112345678' } })
    fireEvent.click(screen.getByRole('button', { name: /Register/ }))

    await waitFor(() => expect(screen.getByText(/You're registered!/)).toBeTruthy())
    // Confirmation shows no name/phone echo.
    expect(screen.queryByText('Amir')).toBeNull()
    expect(screen.queryByText('0112345678')).toBeNull()
  })

  it('shows immediate client feedback for an invalid phone without calling the API', async () => {
    render(<EventRegistrationForm {...PROPS} />)
    fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Amir' } })
    fireEvent.change(screen.getByPlaceholderText('01x-xxxxxxx'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: /Register/ }))

    await waitFor(() => expect(screen.getByText(/valid Malaysian mobile number/)).toBeTruthy())
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
