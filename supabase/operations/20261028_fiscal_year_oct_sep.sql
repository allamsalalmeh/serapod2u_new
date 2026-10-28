-- ============================================================================
-- Staging data fix: fiscal year Oct–Sep (named after the year it ends in)
--
--   FY2025  2024-10-01 .. 2025-09-30   (was calendar 2025)
--   FY2026  2025-10-01 .. 2026-09-30   (was calendar 2026)
--   FY2027  2026-10-01 .. 2027-09-30   (new)
--
-- Periods of the three years are rebuilt (12 monthly periods each):
--   months ending before the current month -> closed
--   the current month                      -> open
--   later months                           -> future
--
-- Safe because (checked 28 Oct 2026 on staging):
--   - gl_journals has no period/fiscal-year column (journals are untouched)
--   - gl_budgets / gl_budget_lines are empty
--
-- Runs in ONE transaction and aborts (changing nothing) if the data is not
-- what was reviewed: exactly FY2025 + FY2026 as calendar years, no budgets.
-- ============================================================================
begin;

do $$
declare
  v_company uuid;
  v_fy25 uuid; v_fy26 uuid; v_fy27 uuid;
  v_count int;
begin
  -- Preconditions -----------------------------------------------------------
  select count(*) into v_count from public.fiscal_years;
  if v_count <> 2 then raise exception 'expected 2 fiscal years, found %', v_count; end if;

  select id, company_id into v_fy25, v_company from public.fiscal_years
   where fiscal_year_code = 'FY2025' and start_date = '2025-01-01' and end_date = '2025-12-31';
  select id into v_fy26 from public.fiscal_years
   where fiscal_year_code = 'FY2026' and start_date = '2026-01-01' and end_date = '2026-12-31';
  if v_fy25 is null or v_fy26 is null then
    raise exception 'FY2025/FY2026 are not the calendar years that were reviewed; aborting';
  end if;

  if exists (select 1 from public.gl_budgets) or exists (select 1 from public.gl_budget_lines) then
    raise exception 'budgets exist; aborting';
  end if;

  -- Fiscal years (earliest first so ranges never overlap mid-way) ------------
  update public.fiscal_years
     set start_date = '2024-10-01', end_date = '2025-09-30', updated_at = now()
   where id = v_fy25;
  update public.fiscal_years
     set start_date = '2025-10-01', end_date = '2026-09-30', updated_at = now()
   where id = v_fy26;

  insert into public.fiscal_years (company_id, fiscal_year_code, fiscal_year_name, start_date, end_date, status)
  values (v_company, 'FY2027', 'Financial Year 2027', '2026-10-01', '2027-09-30', 'open')
  returning id into v_fy27;

  -- Periods ----------------------------------------------------------------
  delete from public.fiscal_periods where fiscal_year_id in (v_fy25, v_fy26);

  insert into public.fiscal_periods
    (company_id, fiscal_year_id, period_number, period_name, start_date, end_date, status, period_type, closed_at)
  select fy.company_id,
         fy.id,
         m.n,
         to_char(m.d, 'FMMonth YYYY'),
         m.d::date,
         (m.d + interval '1 month - 1 day')::date,
         case
           when (m.d + interval '1 month - 1 day')::date < date_trunc('month', current_date)::date then 'closed'
           when m.d::date = date_trunc('month', current_date)::date then 'open'
           else 'future'
         end,
         'normal',   -- allowed: normal | adjustment | opening
         case when (m.d + interval '1 month - 1 day')::date < date_trunc('month', current_date)::date then now() end
    from public.fiscal_years fy
    cross join lateral (
      select g.d, row_number() over (order by g.d)::int as n
        from generate_series(fy.start_date::timestamp, fy.end_date::timestamp, interval '1 month') as g(d)
    ) m
   where fy.id in (v_fy25, v_fy26, v_fy27);

  select count(*) into v_count from public.fiscal_periods where fiscal_year_id in (v_fy25, v_fy26, v_fy27);
  if v_count <> 36 then raise exception 'expected 36 periods, built %', v_count; end if;

  raise notice 'fiscal years switched to Oct-Sep; 36 periods rebuilt';
end $$;

-- Review before COMMIT
select fiscal_year_code, fiscal_year_name, start_date, end_date, status
  from public.fiscal_years order by start_date;

select fy.fiscal_year_code, p.status, count(*) as periods, min(p.start_date) as first_month, max(p.end_date) as last_day
  from public.fiscal_periods p join public.fiscal_years fy on fy.id = p.fiscal_year_id
 group by fy.fiscal_year_code, p.status
 order by fy.fiscal_year_code, min(p.start_date);

commit;
