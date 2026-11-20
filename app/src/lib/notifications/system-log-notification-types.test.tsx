import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_NOTIFICATION_TYPES } from './notificationEventCatalog'
import { categoryLabel, categoryModule, groupByModule } from './notificationTypeModules'
import { getSmsTemplateBody } from '@/config/smsTemplates'
import { getTemplatesForEvent } from '@/config/notificationTemplates'

const types = REQUIRED_NOTIFICATION_TYPES.filter((type) => type.category === 'system_log')
const CODES = ['system_error_critical', 'system_error_application', 'system_error_database']
const render = (template: string, payload: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (_m, key) => payload[key] ?? `MISSING:${key}`)
const PAYLOAD = { environment_label: 'PRODUCTION', alert_title: 'Critical System Error', reference_id: 'SYS-7K3M9QX2', module: 'Supply Chain', severity: 'CRITICAL', occurred_at: '5 Nov 2026, 10:30 am' }
const worker = readFileSync(join(process.cwd(), 'src/app/api/cron/notification-outbox-worker/route.ts'), 'utf8')

describe('System Log notification types', () => {
  it('lists the three types under Platform & Settings as System Log', () => {
    expect(types.map((type) => type.event_code)).toEqual(CODES)
    expect(types.map((type) => type.event_name)).toEqual(['Critical System Error', 'Application / API Error', 'Database Operation Failure'])
    expect(categoryLabel('system_log')).toBe('System Log')
    expect(categoryModule('system_log')).toBe('platform_settings')
    const section = groupByModule([...REQUIRED_NOTIFICATION_TYPES]).find((entry) => entry.id === 'platform_settings')
    expect(section?.categories.find((category) => category.label === 'System Log')?.types).toHaveLength(3)
  })

  it('starts switched off so no production alert is enabled automatically', () => {
    types.forEach((type) => {
      expect(type.default_enabled).toBe(false)
      expect(type.available_channels).toEqual(['whatsapp', 'sms', 'email'])
    })
  })

  it('has safe wording for every channel with every placeholder filled', () => {
    CODES.forEach((code) => {
      const bodies = [getSmsTemplateBody(code), ...['whatsapp', 'email'].flatMap((channel) => getTemplatesForEvent(code, channel).map((template) => template.body))]
      expect(bodies.length).toBeGreaterThanOrEqual(3)
      bodies.forEach((body) => {
        const text = render(String(body), PAYLOAD)
        expect(text).not.toContain('MISSING:')
        expect(text).toContain('SYS-7K3M9QX2')
        expect(text).toContain('PRODUCTION')
      })
    })
  })

  it('the migration matches the catalog and switches nothing on', () => {
    const sql = readFileSync(join(process.cwd(), '../supabase/migrations/20261227100100_system_log_notification_types.sql'), 'utf8')
    CODES.forEach((code) => expect(sql).toContain(`'${code}'`))
    expect(sql).not.toMatch(/\bnotification_settings\s*\(/)
    expect(sql).not.toMatch(/^\s*(INSERT INTO|UPDATE)\s+public\.notification_settings/im)
    types.forEach((type) => expect(sql).toContain(type.event_description))
  })

  it('the outbox worker cannot report into System Logs, so delivery failures cannot re-alert', () => {
    expect(worker).not.toMatch(/system-logs\/(server|alerts)/)
    expect(worker).toContain('SYSTEM_LOG_ALERT_BODY')
  })
})

describe('document_signatures constraint migration', () => {
  const sql = readFileSync(join(process.cwd(), '../supabase/migrations/20261227100000_document_signatures_allow_so_do.sql'), 'utf8')
  const statement = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

  it('keeps an explicit list and adds only SO and DO', () => {
    expect(statement).toContain("ARRAY['PO'::text, 'SO'::text, 'DO'::text, 'INVOICE'::text, 'PAYMENT'::text, 'RECEIPT'::text]")
    expect(statement).not.toContain('PAYMENT_REQUEST')
    expect(statement).not.toMatch(/\bNOT VALID\b|DISABLE TRIGGER|POLICY/i)
  })
})
