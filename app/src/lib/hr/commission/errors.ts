/**
 * Human messages for the database's commission exceptions (hr_commission_* functions, triggers and constraints).
 * Isomorphic: the API maps codes to HTTP statuses, the screens show the message.
 */

const MESSAGES: [RegExp, string, number][] = [
  [/sa_authorization_required/, 'You do not have permission for this commission action.', 403],
  [/sod_violation: commission rate/, 'Segregation of duties: the person who requested this rate change, or the employee concerned, cannot approve it.', 403],
  [/sod_violation: commission cycle/, 'Segregation of duties: the person who calculated or submitted this cycle cannot approve it.', 403],
  [/sod_violation: commission adjustment/, 'Segregation of duties: the requester or the employee concerned cannot decide this adjustment.', 403],
  [/hr_onboarding_pending/, 'This employee has not completed HR onboarding yet.', 409],
  [/hr_commission_rate_overlap|hr_employee_commission_rules_no_overlap/, 'This rate overlaps an existing rate for the same employee and Business Unit. End the existing rate first.', 409],
  [/hr_commission_bu_brands_no_overlap/, 'This brand already belongs to a Business Unit on that date.', 409],
  [/hr_commission_bu_code_uq/, 'A Business Unit with this code already exists.', 409],
  [/hr_commission_rate_invalid/, 'Enter a rate above 0% and at most 100%, with up to 5 decimals.', 400],
  [/hr_commission_reason_required|hr_commission_rule_requests_reason|hr_commission_adjustments_reason/, 'A reason of at least 5 characters is required.', 400],
  [/hr_commission_cycle_finalized/, 'This cycle is approved or locked; its commission cannot change. Record an adjustment in an open cycle instead.', 409],
  [/hr_commission_cycle_not_ended/, 'A cycle can be approved only after its end date has passed.', 409],
  [/hr_commission_review_flags_unacknowledged/, 'Review the flagged items and acknowledge them before approving.', 409],
  [/hr_commission_pending_adjustments/, 'Decide every pending adjustment for this cycle before approving it.', 409],
  [/hr_commission_source_changed/, 'An order in this cycle changed (status or value) since calculation. Recalculate before approving.', 409],
  [/hr_commission_cycle_in_future/, 'That cycle has not started yet.', 400],
  [/hr_commission_settings_overlap_existing_cycles/, 'Settings cannot change months that already have a cycle. Choose a later effective month.', 409],
  [/hr_commission_settings_effective_month/, 'Settings take effect from the first day of a month.', 400],
  [/hr_commission_settings_cycle|hr_commission_settings_statuses|hr_commission_settings_check/, 'Invalid cycle settings (start day 2–28 for a custom cycle; only approved-stage statuses are eligible).', 400],
  [/hr_commission_rule_used_by_final_cycle|hr_commission_mapping_used_by_final_cycle/, 'This change would rewrite commission that is already approved or locked.', 409],
  [/hr_commission_mapping_inside_final_cycle/, 'A brand mapping cannot start inside a period that is already approved or locked.', 409],
  [/hr_commission_payroll_period_invalid/, 'Enter a valid payroll period.', 400],
  [/hr_commission_cycle_transition_invalid|hr_commission_cycle_not_(calculated|under_review|approved|locked|returnable)/, 'This action is not available in the cycle’s current status.', 409],
  [/hr_commission_amount_invalid/, 'Enter a non-zero amount with at most 2 decimals.', 400],
  [/hr_commission_effective_to_invalid/, 'The end date is not valid for this rate.', 400],
  [/hr_commission_[a-z_]*not_found/, 'Not found.', 404],
  [/hr_commission_request_not_pending|hr_commission_adjustment_not_pending/, 'This request has already been decided.', 409],
]

export function commissionErrorOf(message: string | null | undefined): { message: string; status: number } {
  const text = String(message ?? '')
  for (const [re, msg, status] of MESSAGES) if (re.test(text)) return { message: msg, status }
  return { message: 'The commission action could not be completed.', status: 500 }
}
