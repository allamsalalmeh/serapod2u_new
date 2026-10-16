// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.fn()
const single = vi.fn()
const select = vi.fn(() => ({ eq: () => ({ single }) }))

vi.mock('next/navigation', () => ({ usePathname: () => '/store', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <img alt={props.alt} /> }))
vi.mock('@/lib/storefront/cart-context', () => ({ useCart: () => ({ itemCount: 0, items: [] }) }))
vi.mock('@/components/storefront/StoreBrandMark', () => ({ default: () => <span>brand</span> }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser, onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }), signOut: vi.fn() },
    from: () => ({ select }),
  }),
}))

describe('StorefrontNavbar profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'auth@example.com', user_metadata: { full_name: 'Auth Name' } } } })
  })

  it('reads only columns that exist on users and shows the database profile', async () => {
    single.mockResolvedValue({ data: { id: 'u-1', full_name: 'Profile Name', email: 'p@example.com', avatar_url: null, phone: null }, error: null })
    const { default: StorefrontNavbar } = await import('./StorefrontNavbar')
    render(<StorefrontNavbar />)
    await waitFor(() => expect(screen.getAllByText('Profile Name').length).toBeGreaterThan(0))
    expect(select).toHaveBeenCalledWith('id, full_name, email, avatar_url, phone')
  })

  it('falls back to the auth account when the profile cannot be read', async () => {
    single.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const { default: StorefrontNavbar } = await import('./StorefrontNavbar')
    render(<StorefrontNavbar />)
    await waitFor(() => expect(screen.getAllByText('Auth Name').length).toBeGreaterThan(0))
  })
})
