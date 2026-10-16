-- ============================================================================
-- Security & Access — decide tenant-owned RLS write gates at the ROW's organization, not the actor's
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 restored from a schema-only
-- staging dump: supabase/tests/security/sa_actor_org_gates/run.sh).
--
-- Audit (2026-10-07). sa_gate_policy() (20260928110000) was called with p_org_expression = 'public.sa_actor_org_id()'
-- for 110 write policies on 82 tables, producing  sa_rls_gate(perm, sa_actor_org_id(), legacy) OR (...).
-- In NEW_ENFORCED / LEGACY_RETIRED the gate then asks "does the caller hold perm in the caller's OWN organization?"
-- — the same answer for every row — so a grant anywhere passes for all rows of the table. Partner accounts can be
-- granted policies at their own organization (scope-eligibility.ts: "recipient's own organization and beneath"), and
-- on staging (read-only check, 2026-10-07) 12 partner users already pass such gates at their own MFG / SHOP / DIST
-- organization for 18 keys, 13 of them NEW_ENFORCED (customer.support/program/reward/campaign/loyalty/shop,
-- roadtour.*, inventory.return/stock_config/opening_balance, platform.settings, product.catalog, hr.attendance).
-- E.g. a shop account with customer.support.manage at its shop can rewrite the HQ's WhatsApp bot settings.
--
-- Classification of the 82 tables:
--   * Already backed by a row-organization API-role guard (20261019100000 / 20261021100000) or workflow-only:
--     shop_distributors, distributor_products, qr_reverse_jobs, qr_reverse_job_items, qr_prepared_codes,
--     stock_count_session_items / _scope, stock_count_classification_allocation_resolutions, return_case_items,
--     return_case_status_history, serapp_order_holds, stock_adjustment_manufacturer_actions.  Unchanged here.
--   * Tenant-owned rows (this migration): the gate's organization argument becomes the row's organization, taken from
--     the row or from its trusted parent row:
--       organization column     consumer_scan_issue_settings / _templates / consumer_scan_issues (org_id),
--                               consumer_qr_scans (shop_id), distributor_stock_config_eligibility (distributor_org_id),
--                               loyalty_program_organization_memberships / _user_memberships (owner_organization_id),
--                               messaging_channel_settings (hq_organization_id), reference_assignments,
--                               reference_change_log, referral_accruals, referral_adjustments, referral_claims,
--                               user_registration_bonus_settings, whatsapp_bot_admins / _sessions / _settings,
--                               whatsapp_conversations (org_id), tenant_features (tenant_id),
--                               serapp_conversations (owner_org_id)
--       parent row              roadtour_campaign_managers / _official_visits / _qr_codes / _qr_delivery_logs /
--                               _scan_events / _survey_responses (campaign → org_id), roadtour_survey_response_items
--                               (response → campaign), roadtour_survey_template_fields (template → org_id),
--                               journey_order_links (journey → org_id), lucky_draw_order_links (campaign →
--                               company_id), landing_page_products (landing page → organization_id),
--                               hr_overtime_rules (policy → organization_id), inventory_cutoff_decisions (cutoff →
--                               warehouse), redeem_gifts (order → company_id)
--     Where the organization column is nullable (global templates / settings rows), a NULL keeps the previous
--     actor-organization decision for that row only.
--   * Global reference data with no owning organization — NOT changed here (decision pending, see the report):
--     products and the catalog tables (brands, product_*, variant_*, inventory_stock_configurations, product_images),
--     geography (regions, states, districts), organization_types, point_rewards, point_migrations, migration_history,
--     return_conditions / _reasons / _settings, hr_overtime_presets, support_* (one HQ support desk; no organization
--     column), admin_whatsapp_identities, serapp_user_presence.
--
-- Mechanics. Only the first two arguments of the gate change: sa_rls_gate('<perm>'::text, sa_actor_org_id(), …)
-- becomes sa_rls_gate('<perm>'::text, <row organization>, …) in USING and WITH CHECK of the table's non-SELECT policies.
-- The legacy expression and the NEW-mode remainder are untouched, so LEGACY_ENFORCED / SHADOW behave exactly as
-- before, other permissive policies (consumer / self-service inserts) are unaffected, and organization scopes still
-- reach descendants through the row organization's ancestry (an HQ grant covers its distributors and shops).
-- Parent organizations are resolved by sa_row_parent_org() (SECURITY DEFINER), so a write never depends on whether
-- the caller can SELECT the parent row; it returns only an organization id for a parent id the caller supplies.
-- sa_policy_rewrites.organization_expression is updated to the new expression (original_using / original_check —
-- the pre-S&A policies — are untouched).
--
-- Intentional tightening once each key is enforced: a grant held only at an organization outside the row's
-- organization chain no longer authorizes the write (partner-org grants stop reaching HQ-owned rows; MFG root
-- organizations, which are not under the HQ, stop reaching HQ rows).
--
-- Not changed: no mode, grant, assignment, readiness row, trigger or SELECT policy.
-- Order: requires 20260928100000 … 20260928130000. Independent of 20261019* / 20261020* / 20261021*. Repeat-safe.
--
-- Rollback (per environment): for every table listed in section 2,
--   alter policy … using / with check: replace 'sa_rls_gate(''<perm>''::text, <expr>,' by
--   'sa_rls_gate(''<perm>''::text, sa_actor_org_id(),' — i.e. run section 2 with v_from/v_to swapped — and
--   update sa_policy_rewrites set organization_expression = 'public.sa_actor_org_id()' for those rows;
--   drop function if exists public.sa_row_parent_org(text, uuid);
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trusted parent organization
-- ---------------------------------------------------------------------------
create or replace function public.sa_row_parent_org(p_kind text, p_id uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case p_kind
    when 'roadtour_campaign'        then (select c.org_id from public.roadtour_campaigns c where c.id = p_id)
    when 'roadtour_survey_response' then (select c.org_id from public.roadtour_survey_responses r
                                            join public.roadtour_campaigns c on c.id = r.campaign_id where r.id = p_id)
    when 'roadtour_survey_template' then (select t.org_id from public.roadtour_survey_templates t where t.id = p_id)
    when 'journey_configuration'    then (select j.org_id from public.journey_configurations j where j.id = p_id)
    when 'lucky_draw_campaign'      then (select l.company_id from public.lucky_draw_campaigns l where l.id = p_id)
    when 'landing_page'             then (select l.organization_id from public.landing_pages l where l.id = p_id)
    when 'hr_overtime_policy'       then (select p.organization_id from public.hr_overtime_policies p where p.id = p_id)
    when 'inventory_opening_cutoff' then (select c.warehouse_organization_id from public.inventory_opening_cutoffs c where c.id = p_id)
    when 'order_company'            then (select o.company_id from public.orders o where o.id = p_id)
  end
$$;
revoke all on function public.sa_row_parent_org(text, uuid) from public;
-- Policy expressions run as the caller (anon for "public" policies), so the caller must be able to execute it.
grant execute on function public.sa_row_parent_org(text, uuid) to anon, authenticated, service_role;
comment on function public.sa_row_parent_org(text, uuid) is
  'Organization that owns a parent row, for S&A RLS gates on child tables (decided at the row''s organization).';

-- ---------------------------------------------------------------------------
-- 2. Re-point the gates
-- ---------------------------------------------------------------------------
create table if not exists public.sa_actor_org_gate_targets (
  table_name text primary key,
  organization_expression text not null
);
alter table public.sa_actor_org_gate_targets enable row level security;
alter table public.sa_actor_org_gate_targets force row level security;
revoke all on table public.sa_actor_org_gate_targets from public, anon, authenticated, service_role;
grant select on table public.sa_actor_org_gate_targets to service_role;
comment on table public.sa_actor_org_gate_targets is
  'Tables whose S&A write gates were moved from the actor''s organization to the row''s (20261022100000); rollback reference.';

insert into public.sa_actor_org_gate_targets(table_name, organization_expression) values
  ('consumer_scan_issue_settings',             'org_id'),
  ('consumer_scan_issue_templates',            'COALESCE(org_id, sa_actor_org_id())'),
  ('consumer_scan_issues',                     'COALESCE(org_id, sa_actor_org_id())'),
  ('consumer_qr_scans',                        'COALESCE(shop_id, sa_actor_org_id())'),
  ('distributor_stock_config_eligibility',     'distributor_org_id'),
  ('loyalty_program_organization_memberships', 'owner_organization_id'),
  ('loyalty_program_user_memberships',         'owner_organization_id'),
  ('messaging_channel_settings',               'hq_organization_id'),
  ('reference_assignments',                    'org_id'),
  ('reference_change_log',                     'org_id'),
  ('referral_accruals',                        'org_id'),
  ('referral_adjustments',                     'org_id'),
  ('referral_claims',                          'org_id'),
  ('user_registration_bonus_settings',         'org_id'),
  ('whatsapp_bot_admins',                      'org_id'),
  ('whatsapp_bot_sessions',                    'org_id'),
  ('whatsapp_bot_settings',                    'org_id'),
  ('whatsapp_conversations',                   'org_id'),
  ('tenant_features',                          'COALESCE(tenant_id, sa_actor_org_id())'),
  ('serapp_conversations',                     'owner_org_id'),
  ('roadtour_campaign_managers',               'sa_row_parent_org(''roadtour_campaign''::text, campaign_id)'),
  ('roadtour_official_visits',                 'sa_row_parent_org(''roadtour_campaign''::text, campaign_id)'),
  ('roadtour_qr_codes',                        'sa_row_parent_org(''roadtour_campaign''::text, campaign_id)'),
  ('roadtour_qr_delivery_logs',                'sa_row_parent_org(''roadtour_campaign''::text, campaign_id)'),
  ('roadtour_scan_events',                     'sa_row_parent_org(''roadtour_campaign''::text, campaign_id)'),
  ('roadtour_survey_responses',                'sa_row_parent_org(''roadtour_campaign''::text, campaign_id)'),
  ('roadtour_survey_response_items',           'sa_row_parent_org(''roadtour_survey_response''::text, response_id)'),
  ('roadtour_survey_template_fields',          'sa_row_parent_org(''roadtour_survey_template''::text, template_id)'),
  ('journey_order_links',                      'sa_row_parent_org(''journey_configuration''::text, journey_config_id)'),
  ('lucky_draw_order_links',                   'sa_row_parent_org(''lucky_draw_campaign''::text, campaign_id)'),
  ('landing_page_products',                    'sa_row_parent_org(''landing_page''::text, landing_page_id)'),
  ('hr_overtime_rules',                        'sa_row_parent_org(''hr_overtime_policy''::text, policy_id)'),
  ('inventory_cutoff_decisions',               'sa_row_parent_org(''inventory_opening_cutoff''::text, cutoff_id)'),
  ('redeem_gifts',                             'sa_row_parent_org(''order_company''::text, order_id)')
on conflict (table_name) do update set organization_expression = excluded.organization_expression;

do $repoint$
declare
  t record;
  p record;
  v_from text := 'sa_rls_gate\(''([a-z_.]+)''::text, sa_actor_org_id\(\),';
  v_to text;
  v_qual text;
  v_check text;
  v_n int := 0;
begin
  for t in select * from public.sa_actor_org_gate_targets order by table_name loop
    if to_regclass('public.' || t.table_name) is null then
      raise notice 'sa_actor_org_gates: % not present, skipped', t.table_name;
      continue;
    end if;
    -- regexp replacement text: backslashes are special, the expressions contain none.
    v_to := 'sa_rls_gate(''\1''::text, ' || t.organization_expression || ',';
    for p in
      select pol.polname, pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as wcheck
      from pg_policy pol
      where pol.polrelid = ('public.' || t.table_name)::regclass and pol.polcmd <> 'r'
    loop
      v_qual := regexp_replace(p.qual, v_from, v_to, 'g');
      v_check := regexp_replace(p.wcheck, v_from, v_to, 'g');
      if v_qual is distinct from p.qual then
        execute format('alter policy %I on public.%I using (%s)', p.polname, t.table_name, v_qual);
      end if;
      if v_check is distinct from p.wcheck then
        execute format('alter policy %I on public.%I with check (%s)', p.polname, t.table_name, v_check);
      end if;
      if v_qual is distinct from p.qual or v_check is distinct from p.wcheck then
        v_n := v_n + 1;
        update public.sa_policy_rewrites set organization_expression = t.organization_expression
        where table_name = t.table_name and policy_name = p.polname;
      end if;
    end loop;
  end loop;
  raise notice 'sa_actor_org_gates: % policies re-pointed to the row organization', v_n;
end $repoint$;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions
-- ---------------------------------------------------------------------------
do $$
declare
  v_left text;
begin
  select string_agg(format('%s.%s', c.relname, pol.polname), ', ') into v_left
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join public.sa_actor_org_gate_targets t on t.table_name = c.relname
  where c.relnamespace = 'public'::regnamespace and pol.polcmd <> 'r'
    and (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'sa_rls_gate\(''[a-z_.]+''::text, sa_actor_org_id\(\),'
      or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'sa_rls_gate\(''[a-z_.]+''::text, sa_actor_org_id\(\),');
  if v_left is not null then
    raise exception 'postcondition: write gates still decided at the actor''s organization: %', v_left;
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sa_row_parent_org(text,uuid)'::regprocedure) then
    raise exception 'postcondition: sa_row_parent_org must be SECURITY DEFINER';
  end if;
  if has_function_privilege('public', 'public.sa_row_parent_org(text,uuid)', 'EXECUTE') then
    raise exception 'postcondition: sa_row_parent_org must not be granted to PUBLIC';
  end if;
end $$;
