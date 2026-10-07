import { describe, expect, it } from 'vitest'
import {
  isEventManagementViewId,
  eventManagementHrefForView,
  getEventManagementBreadcrumb,
  eventManagementEventTabs,
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
    expect(crumbs.map((c) => c.label)).toEqual(['Customer & Growth', 'Marketing', 'Event Management', 'Visitors'])
  })
})
