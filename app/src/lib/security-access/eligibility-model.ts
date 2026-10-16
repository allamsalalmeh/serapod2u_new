import 'server-only'
import { isSchemaMissing } from './diagnostics'
import type { EligibilityModel } from './recipient-eligibility'

/**
 * Which recipient-eligibility rule the connected database enforces (see recipient-eligibility.ts).
 *
 * 'org_type' once 20261030100000_sa_policy_org_type_eligibility.sql is applied (its classification table exists);
 * 'legacy' only when that table is verifiably missing — the database then still applies its previous rule, and the
 * pickers must neither offer what it refuses nor hide what it accepts. Any other failure answers 'org_type', the
 * stricter rule (fail closed: a policy may be hidden, never wrongly offered). `admin` is the service-role client.
 */
export async function loadEligibilityModel(admin: any): Promise<EligibilityModel> {
  try {
    const { error } = await admin.from('sa_org_type_eligibility').select('org_type_code').limit(1)
    if (error && isSchemaMissing(error)) return 'legacy'
    return 'org_type'
  } catch {
    return 'org_type'
  }
}
