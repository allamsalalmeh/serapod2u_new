/**
 * Staff Sales Commission release switch (owner decision, 2026-10-16 production release).
 *
 * The commission screens, APIs and the People / Reporting tabs ship dark: they answer only where the environment sets
 * HR_COMMISSION_ENABLED=true (server-side). While HR compensation is not S&A-authoritative the database lets every
 * active Super Admin of the company use commission (hr_commission_allowed), so without this switch the feature would
 * open to Super Admins the moment the code is deployed. The switch never widens access: when it is on, the database
 * still decides every read and action.
 */
export const COMMISSION_RELEASE_ENV = 'HR_COMMISSION_ENABLED'

export function commissionReleased(env: Record<string, string | undefined> = process.env): boolean {
  return env[COMMISSION_RELEASE_ENV] === 'true'
}

export const COMMISSION_NOT_RELEASED = { success: false, error: 'Staff Sales Commission is not available.', code: 'commission_not_released' } as const
