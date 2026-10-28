-- ============================================================================
-- 20261224100000_hr_w3_wp_holiday_alias.sql
-- Serapod2U HR Core — Wave 3 correction (OPTIONAL, prepared 2026-10-26; NOT applied anywhere).
--
-- Finding (KVM2 staging read-only output out-w2w3-20261025-195856, section B6): one public holiday is recorded with
-- state = 'WP' (Wilayah Persekutuan — e.g. Federal Territory Day). hr_att_day_type (20261222100000) matched state
-- holidays only by full state name or the statutory work-state code (KUL/LBN/PJY), so a 'WP' holiday would never
-- apply to employees working in Kuala Lumpur, Labuan or Putrajaya.
-- Correction: the same function with the Federal-Territory aliases 'wp', 'w.p.', 'wilayah persekutuan',
-- 'federal territory(ies)' for KUL, LBN and PJY (a holiday of ALL three territories, e.g. Federal Territory Day), plus
-- the per-territory spellings 'w.p. labuan' / 'w.p. putrajaya' / 'wilayah persekutuan <territory>' that were missing for
-- Labuan and Putrajaya. Territory-specific holidays stay separate: 'Labuan' matches only LBN, 'Putrajaya' only PJY,
-- 'Kuala Lumpur' only KUL (2026-10-26 review; replica tests WP1–WP12). Nothing else changes (signature, grants, owner,
-- other states, national holidays, workdays). No data is written. Used by attendance day types, overtime day types and
-- the leave working-day quote (hr_leave_working_dates → hr_att_day_type).
--
-- Impact today: none on staging — 0 employees have a work state captured (B6), so only national holidays apply.
-- Apply when work states are captured, or before Federal Territory Day. Alternative without SQL: HR records the
-- holiday with state "Kuala Lumpur" (and separate rows for Labuan / Putrajaya).
-- Requires 20261222100000. Idempotent (create or replace).
-- ROLLBACK: re-run the hr_att_day_type definition from 20261222100000 (section 4).
-- ============================================================================
do $pre$ begin
  if to_regprocedure('public.hr_att_day_type(uuid,uuid,date)') is null then
    raise exception 'hr_w3_prerequisite_missing: 20261222100000_hr_hybrid_attendance_overtime must be applied first';
  end if;
end $pre$;

create or replace function public.hr_att_day_type(p_org uuid, p_employee uuid, p_date date)
returns text language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_state text; v_names text[]; v_workdays text[];
begin
  select sp.work_state into v_state from public.hr_employee_statutory_profiles sp where sp.user_id = p_employee;
  v_names := case v_state
    when 'JHR' then array['johor'] when 'KDH' then array['kedah'] when 'KTN' then array['kelantan']
    when 'MLK' then array['melaka', 'malacca'] when 'NSN' then array['negeri sembilan'] when 'PHG' then array['pahang']
    when 'PNG' then array['pulau pinang', 'penang'] when 'PRK' then array['perak'] when 'PLS' then array['perlis']
    when 'SBH' then array['sabah'] when 'SWK' then array['sarawak'] when 'SGR' then array['selangor']
    when 'TRG' then array['terengganu']
    -- Federal Territories: a holiday recorded as 'WP' / 'Wilayah Persekutuan' / 'Federal Territory' applies to all three
    -- Each territory keeps its own names (a 'Labuan' holiday never applies in Kuala Lumpur or Putrajaya).
    when 'KUL' then array['kuala lumpur', 'wp kuala lumpur', 'w.p. kuala lumpur', 'wilayah persekutuan kuala lumpur',
                          'wp', 'w.p.', 'wilayah persekutuan', 'federal territory', 'federal territories']
    when 'LBN' then array['labuan', 'wp labuan', 'w.p. labuan', 'wilayah persekutuan labuan',
                          'wp', 'w.p.', 'wilayah persekutuan', 'federal territory', 'federal territories']
    when 'PJY' then array['putrajaya', 'wp putrajaya', 'w.p. putrajaya', 'wilayah persekutuan putrajaya',
                          'wp', 'w.p.', 'wilayah persekutuan', 'federal territory', 'federal territories'] else array[]::text[] end;
  if exists (select 1 from public.hr_public_holidays h
             where h.organization_id = any(public.sa_org_ancestry(p_org))
               and (h.date = p_date or (h.is_recurring and extract(month from h.date) = extract(month from p_date)
                                        and extract(day from h.date) = extract(day from p_date)))
               and (h.state is null or btrim(h.state) = '' or lower(btrim(h.state)) = any(v_names)
                    or upper(btrim(h.state)) = v_state)) then
    return 'public_holiday';
  end if;
  select p.workdays into v_workdays from public.hr_attendance_policies p where p.organization_id = p_org;
  v_workdays := coalesce(v_workdays, array['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  if not (to_char(p_date, 'Dy') = any(v_workdays)) then return 'rest_day'; end if;
  return 'normal';
end $fn$;
revoke all on function public.hr_att_day_type(uuid,uuid,date) from public, anon, authenticated, service_role;
