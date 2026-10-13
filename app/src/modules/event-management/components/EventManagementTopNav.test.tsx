// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EventManagementTopNav from './EventManagementTopNav'

describe('EventManagementTopNav', () => {
  afterEach(cleanup)

  it('shows Overview / Events / Settings and navigates by view id', () => {
    const onNavigate = vi.fn()
    render(<EventManagementTopNav currentView="event-management" onNavigate={onNavigate} />)
    expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: 'Events' }))
    expect(onNavigate).toHaveBeenCalledWith('event-management-events')
    fireEvent.click(screen.getByRole('button', { name: 'Event Management' }))
    expect(onNavigate).toHaveBeenCalledWith('event-management')
  })

  it('keeps Events highlighted inside an event', () => {
    render(<EventManagementTopNav currentView="event-staff-qr" onNavigate={() => {}} />)
    expect(screen.getByRole('button', { name: 'Events' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBeNull()
  })
})
