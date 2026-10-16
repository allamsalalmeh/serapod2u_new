import { describe, expect, it } from 'vitest'
import { getSettingsBreadcrumb, settingsNavGroups, visibleSettingsGroups } from './settingsNav'

describe('Settings → System → System Logs placement', () => {
  it('places System after AI Settings and before Danger Zone (landing card beside Danger Zone)', () => {
    const ids = settingsNavGroups.map(g => g.id)
    expect(ids.indexOf('settings-system')).toBe(ids.indexOf('settings-ai') + 1)
    expect(ids.indexOf('settings-danger-zone')).toBe(ids.indexOf('settings-system') + 1)
    expect(settingsNavGroups.find(g => g.id === 'settings-system')!.children.map(c => [c.id, c.href]))
      .toEqual([['settings/system/logs', '/settings/system/logs']])
    expect(getSettingsBreadcrumb('settings/system/logs').map(c => c.label)).toEqual(['Settings', 'System', 'System Logs'])
  })

  it('shows the System group only to viewers allowed to read System Logs (Settings access alone is not enough)', () => {
    const shown = (v: Parameters<typeof visibleSettingsGroups>[0]) => visibleSettingsGroups(v).map(g => g.id)
    expect(shown({ roleLevel: 10 })).not.toContain('settings-system')
    expect(shown({ roleLevel: 1, canViewSystemLogs: false })).not.toContain('settings-system')
    expect(shown({ roleLevel: 40, canViewSystemLogs: true })).toContain('settings-system')
    // Existing rules unchanged.
    expect(shown({ roleLevel: 10, canViewSystemLogs: true })).not.toContain('settings-danger-zone')
    expect(shown({ roleLevel: 1, canViewSystemLogs: true }).slice(-3)).toEqual(['settings-ai', 'settings-system', 'settings-danger-zone'])
  })
})
