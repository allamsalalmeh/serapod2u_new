/**
 * Wording of System Log alerts. Only the safe fields of lib/system-logs/alerts are used: no database error, path, user
 * or customer data. Technical detail stays behind the reference, in Settings → System → System Logs.
 */
export const SYSTEM_LOG_ALERT_BODY = `[{{environment_label}}] Serapod2U: {{alert_title}}\nReference: {{reference_id}}\nModule: {{module}}\nSeverity: {{severity}}\nTime: {{occurred_at}}\nOpen Settings > System > System Logs and search the reference.`

export const SYSTEM_LOG_ALERT_SMS_BODY = `[Serapod2U {{environment_label}}] {{alert_title}}. Ref {{reference_id}}, {{module}}, {{severity}}, {{occurred_at}}.`
