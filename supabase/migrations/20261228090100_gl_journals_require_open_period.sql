-- ============================================================================
-- Finance: a POSTED journal must fall in an OPEN accounting period
--
-- Until now only post_payroll_run_to_gl checked the period. post_document_to_gl,
-- the auto-post path, reverse_gl_journal and the HR posting functions wrote
-- journals into closed or future periods without any check.
--
-- Instead of editing each of those functions, one BEFORE trigger on
-- gl_journals enforces the rule for every writer, present and future:
--
--   * applies when a journal is inserted as POSTED, becomes POSTED, or a
--     POSTED journal's journal_date changes
--   * the journal_date must be inside a fiscal period with status 'open'
--     whose fiscal year is not 'locked' (same rule as is_posting_date_allowed)
--   * companies with no fiscal periods at all are not blocked
--   * deliberate override for admin data scripts (opening balances, legacy
--     migration), set inside that script's own transaction:
--         set local app.allow_closed_period_posting = 'on';
--
-- Callers that must not fail (auto_post_document_to_gl,
-- auto_post_payment_to_gl) already catch exceptions, so a rejected auto-post
-- leaves the document unposted instead of failing the business action.
--
-- Rollback:
--   drop trigger if exists trg_gl_journals_require_open_period on public.gl_journals;
--   drop function if exists public.gl_journals_require_open_period();
-- ============================================================================

create or replace function public.gl_journals_require_open_period()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_status text;
  v_year_status   text;
begin
  -- Only posted journals are checked
  if new.status is distinct from 'POSTED' then
    return new;
  end if;

  -- A posted journal being updated without moving its date (e.g. metadata) is fine
  if tg_op = 'UPDATE'
     and old.status = 'POSTED'
     and old.journal_date is not distinct from new.journal_date then
    return new;
  end if;

  -- Explicit override for admin data scripts
  if coalesce(current_setting('app.allow_closed_period_posting', true), '') = 'on' then
    return new;
  end if;

  -- Companies that have not set up fiscal periods are not blocked
  if not exists (select 1 from public.fiscal_periods fp where fp.company_id = new.company_id) then
    return new;
  end if;

  select fp.status, fy.status
    into v_period_status, v_year_status
    from public.fiscal_periods fp
    join public.fiscal_years fy on fy.id = fp.fiscal_year_id
   where fp.company_id = new.company_id
     and new.journal_date between fp.start_date and fp.end_date
   order by (fp.status = 'open') desc
   limit 1;

  if v_period_status = 'open' and v_year_status in ('open', 'closed') then
    return new;
  end if;

  raise exception using
    errcode = 'P0001',
    message = format(
      'Journal date %s is not in an open accounting period (%s). Open the period in Finance Settings > Fiscal Year & Periods first.',
      to_char(new.journal_date, 'DD/MM/YYYY'),
      case
        when v_period_status is null then 'no period defined for this date'
        when v_year_status = 'locked' then 'fiscal year is locked'
        else 'period is ' || v_period_status
      end
    );
end;
$$;

drop trigger if exists trg_gl_journals_require_open_period on public.gl_journals;

create trigger trg_gl_journals_require_open_period
  before insert or update of status, journal_date
  on public.gl_journals
  for each row
  execute function public.gl_journals_require_open_period();
