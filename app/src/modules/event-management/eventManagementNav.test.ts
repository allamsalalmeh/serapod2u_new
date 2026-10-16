import { describe, expect, it } from 'vitest'
import {
  isEventManagementViewId,
  eventManagementHrefForView,
  getEventManagementBreadcrumb,
  eventManagementEventTabs,
  eventManagementModuleTabs,
  activeEventManagementModuleTab,
  resolveEventTab,
  eventTabHref,
  shouldRenderServerContent,
} from './eventManagementNav'

describe('eventManagementNav', () => {
  it('recognises the module and its subviews', () => {
    expect(isEventManagementViewId('event-management')).toBe(true)
    expect(isEventManagementViewId('event-management-overview')).toBe(true)
    expect(isEventManagementViewId('event-overview')).toBe(true)
    expect(isEventManagementViewId('roadtour')).toBe(false)
  })

  it('maps the module id to its route', () => {
    expect(eventManagementHrefForView('event-management')).toBe('/marketing/event-management')
    expect(eventManagementHrefForView('event-management-overview')).toBe('/marketing/event-management')
    expect(eventManagementHrefForView('event-management-events')).toBe('/marketing/event-management/events')
    expect(eventManagementHrefForView('event-management-settings')).toBe('/marketing/event-management/settings')
    expect(eventManagementHrefForView('roadtour')).toBeNull()
  })

  it('offers Overview / Events / Settings as module tabs, each with its own URL', () => {
    expect(eventManagementModuleTabs.map((t) => t.label)).toEqual(['Overview', 'Events', 'Settings'])
    expect(new Set(eventManagementModuleTabs.map((t) => t.route)).size).toBe(3)
  })

  it('keeps Events active inside an event', () => {
    expect(activeEventManagementModuleTab('event-management')).toBe('event-management')
    expect(activeEventManagementModuleTab('event-management-settings')).toBe('event-management-settings')
    expect(activeEventManagementModuleTab('event-visitors')).toBe('event-management-events')
    expect(activeEventManagementModuleTab('mktg')).toBeNull()
  })

  it('maps per-event URL segments to tabs and back', () => {
    expect(resolveEventTab(undefined)).toBe('event-overview')
    expect(resolveEventTab(['visitors'])).toBe('event-visitors')
    expect(resolveEventTab(['staff-qr'])).toBe('event-staff-qr')
    expect(resolveEventTab(['settings'])).toBe('event-settings')
    expect(resolveEventTab(['nope'])).toBeNull()
    expect(resolveEventTab(['visitors', 'x'])).toBeNull()
    expect(eventTabHref('e1', 'event-overview')).toBe('/marketing/event-management/e1')
    expect(eventTabHref('e1', 'event-staff-qr')).toBe('/marketing/event-management/e1/staff-qr')
  })

  it('provides the four per-event tabs', () => {
    expect(eventManagementEventTabs.map((t) => t.id)).toEqual([
      'event-overview',
      'event-visitors',
      'event-staff-qr',
      'event-settings',
    ])
  })

  it('builds a breadcrumb under Customer & Growth -> Marketing', () => {
    const crumbs = getEventManagementBreadcrumb('event-visitors')
    expect(crumbs.map((c) => c.label)).toEqual(['Customer & Growth', 'Marketing', 'Event Management', 'Events', 'Visitors'])
    expect(getEventManagementBreadcrumb('event-management-settings').map((c) => c.label)).toEqual(['Customer & Growth', 'Marketing', 'Event Management', 'Settings'])
  })

  // Regression: clicking Event Management on /customer-growth moved the shell to 'event-management' before its page
  // arrived; with no server content the shell fell through to the general dashboard.
  describe('shouldRenderServerContent (pending navigation)', () => {
    it('shows the page content only while it belongs to the current view', () => {
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'event-management', initialView: 'event-management' })).toBe(true)
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'event-management-overview', initialView: 'event-management' })).toBe(true)
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'event-visitors', initialView: 'event-visitors' })).toBe(true)
    })

    it('never shows the previous page content under Event Management chrome', () => {
      expect(shouldRenderServerContent({ hasServerContent: false, currentView: 'event-management', initialView: 'customer-growth' })).toBe(false)
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'event-management', initialView: 'event-management-events' })).toBe(false)
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'event-management-events', initialView: 'event-overview' })).toBe(false)
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'event-management', initialView: 'hr/people' })).toBe(false)
    })

    it('does not keep Event Management content under another module', () => {
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'roadtour', initialView: 'event-management' })).toBe(false)
    })

    it('leaves other server-rendered pages unchanged', () => {
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'hr/people', initialView: 'hr/people' })).toBe(true)
      expect(shouldRenderServerContent({ hasServerContent: true, currentView: 'hr-x', initialView: 'hr/people' })).toBe(true)
    })
  })
})
