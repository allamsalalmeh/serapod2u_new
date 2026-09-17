import { getSmsTemplateBody, getSmsTemplatesForEvent } from '@/config/smsTemplates'

type SmsSettingLike = {
  templates?: Record<string, unknown> | null
} | null | undefined

type SupabaseLikeClient = any

function firstRow<T>(data: T | T[] | null | undefined): T | null {
  if (!data) return null
  return Array.isArray(data) ? (data[0] || null) : data
}

function savedSmsTemplate(setting: SmsSettingLike): string {
  return String(setting?.templates?.sms || '').trim()
}

/** Resolve SMS copy from Notification Types (UI drawer), then the catalog. */
export function resolveSmsTemplateBody(eventCode: string, setting?: SmsSettingLike): string {
  const saved = savedSmsTemplate(setting)
  if (saved) {
    const byId = getSmsTemplatesForEvent(eventCode).find((template) => template.id === saved)
    return String(byId?.body || saved).trim()
  }
  return String(getSmsTemplateBody(eventCode) || '').trim()
}

export async function loadOrgEventSetting(
  supabase: SupabaseLikeClient,
  orgId: string,
  eventCode: string,
): Promise<any | null> {
  const loadForOrg = async (id: string) => {
    const { data } = await supabase
      .from('notification_settings')
      .select('templates, channels_enabled, recipient_config')
      .eq('org_id', id)
      .eq('event_code', eventCode)
      .limit(1)
    return firstRow(data)
  }

  const local = await loadForOrg(orgId)
  if (local) return local

  const { data: hq } = await supabase
    .from('organizations')
    .select('id')
    .eq('org_type_code', 'HQ')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
  const hqId = firstRow(hq)?.id
  if (hqId && String(hqId) !== String(orgId)) {
    return loadForOrg(String(hqId))
  }
  return null
}

export async function loadOrgSmsTemplateBody(
  supabase: SupabaseLikeClient,
  orgId: string,
  eventCode: string,
): Promise<string> {
  const loadForOrg = async (id: string) => {
    const { data } = await supabase
      .from('notification_settings')
      .select('templates')
      .eq('org_id', id)
      .eq('event_code', eventCode)
      .limit(1)
    return firstRow(data) as SmsSettingLike
  }

  const local = await loadForOrg(orgId)
  if (savedSmsTemplate(local)) return resolveSmsTemplateBody(eventCode, local)

  const { data: hq } = await supabase
    .from('organizations')
    .select('id')
    .eq('org_type_code', 'HQ')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
  const hqId = firstRow(hq)?.id
  if (hqId && String(hqId) !== String(orgId)) {
    const hqSetting = await loadForOrg(String(hqId))
    if (savedSmsTemplate(hqSetting)) return resolveSmsTemplateBody(eventCode, hqSetting)
  }

  return resolveSmsTemplateBody(eventCode, null)
}
