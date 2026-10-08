// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Avatar, AvatarFallback, AvatarImage } from './avatar'
import { getAvatarSrc } from '@/lib/utils'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Each test uses its own URL: the component remembers loaded URLs per session.
let urlSeq = 0
const nextUrl = () => `https://cdn.test/avatars/u-1/${Date.now()}-${++urlSeq}.jpg`

const renderAvatar = (src: string | undefined) =>
  render(
    <Avatar data-testid="avatar">
      {src && <AvatarImage src={src} alt="Admin" />}
      <AvatarFallback>AD</AvatarFallback>
    </Avatar>,
  )

const imgs = () => Array.from(screen.getByTestId('avatar').querySelectorAll('img'))
const visibleImgs = () => imgs().filter((img) => !img.className.includes('invisible'))

describe('Avatar', () => {
  it('shows initials while loading, then only the image once it loads', () => {
    const src = nextUrl()
    renderAvatar(src)
    expect(screen.getByText('AD')).toBeTruthy()
    expect(visibleImgs()).toHaveLength(0)

    fireEvent.load(imgs()[0])
    expect(screen.queryByText('AD')).toBeNull()
    expect(visibleImgs().map((img) => img.getAttribute('src'))).toEqual([src])
  })

  it('shows an image that finished loading before hydration attached onLoad', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(150)
    renderAvatar(nextUrl())
    // No load event is ever dispatched.
    expect(screen.queryByText('AD')).toBeNull()
    expect(visibleImgs()).toHaveLength(1)
  })

  it('falls back to initials on a failed image and does not retry it', () => {
    const src = nextUrl()
    const { rerender } = renderAvatar(src)
    fireEvent.error(imgs()[0])
    expect(screen.getByText('AD')).toBeTruthy()
    expect(imgs()).toHaveLength(0)

    rerender(
      <Avatar data-testid="avatar">
        <AvatarImage src={src} alt="Admin" />
        <AvatarFallback>AD</AvatarFallback>
      </Avatar>,
    )
    expect(imgs()).toHaveLength(0)
  })

  it('keeps the previous image visible while a replaced avatar loads', () => {
    const oldSrc = nextUrl()
    const newSrc = nextUrl()
    const { rerender } = renderAvatar(oldSrc)
    fireEvent.load(imgs()[0])

    rerender(
      <Avatar data-testid="avatar">
        <AvatarImage src={newSrc} alt="Admin" />
        <AvatarFallback>AD</AvatarFallback>
      </Avatar>,
    )
    expect(screen.queryByText('AD')).toBeNull()
    expect(visibleImgs().map((img) => img.getAttribute('src'))).toEqual([oldSrc])

    fireEvent.load(imgs().find((img) => img.getAttribute('src') === newSrc)!)
    expect(imgs().map((img) => img.getAttribute('src'))).toEqual([newSrc])
    expect(visibleImgs()).toHaveLength(1)
  })

  it('remounts an already-loaded avatar without flashing initials', () => {
    const src = nextUrl()
    renderAvatar(src)
    fireEvent.load(imgs()[0])
    cleanup()

    renderAvatar(src)
    expect(screen.queryByText('AD')).toBeNull()
    expect(visibleImgs()).toHaveLength(1)
  })

  it('restores initials when the avatar is removed', () => {
    const src = nextUrl()
    const { rerender } = renderAvatar(src)
    fireEvent.load(imgs()[0])
    expect(screen.queryByText('AD')).toBeNull()

    act(() => {
      rerender(
        <Avatar data-testid="avatar">
          <AvatarFallback>AD</AvatarFallback>
        </Avatar>,
      )
    })
    expect(screen.getByText('AD')).toBeTruthy()
  })

  it('does not change the image element when the parent re-renders', () => {
    const src = nextUrl()
    const { rerender } = renderAvatar(src)
    fireEvent.load(imgs()[0])
    const node = imgs()[0]
    rerender(
      <Avatar data-testid="avatar">
        <AvatarImage src={src} alt="Admin" />
        <AvatarFallback>AD</AvatarFallback>
      </Avatar>,
    )
    expect(imgs()[0]).toBe(node)
  })
})

describe('getAvatarSrc', () => {
  it('is stable for the same stored URL and keeps the upload version', () => {
    const stored = 'https://supabase.test/storage/v1/object/public/avatars/u-1/1791458653931.jpg?v=1791458654071'
    const first = getAvatarSrc(stored)
    expect(getAvatarSrc(stored)).toBe(first)
    expect(first).toContain('/avatars/u-1/1791458653931.jpg')
    expect(first).toContain('v=1791458654071')
  })

  it('returns nothing when there is no avatar', () => {
    expect(getAvatarSrc(null)).toBeUndefined()
    expect(getAvatarSrc('')).toBeUndefined()
  })
})
