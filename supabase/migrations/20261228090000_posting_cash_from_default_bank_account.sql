-- ============================================================================
-- Finance: post cash/bank lines to the default bank account's GL account
--
-- get_posting_preview() took the cash/bank account only from
-- gl_settings.cash_account_id (Default Accounts, currently 1100), and ignored
-- the bank_accounts register. Supplier deposit and balance payments therefore
-- always credited 1100, whatever bank was set up.
--
-- After this migration the cash/bank account is resolved as:
--   1. the GL account linked to the company's default, active bank account
--      (Cash & Banking > Bank Accounts), e.g. Hong Leong -> 1110
--   2. otherwise gl_settings.cash_account_id (unchanged fallback)
--
-- Only that one SELECT inside the live function body is rewritten; everything
-- else stays as it is. Journals already posted are NOT changed.
--
-- Idempotent: a body that already contains the new lookup is left alone.
-- Rollback: replace the new block with the original single SELECT (below).
-- ============================================================================
do $$
declare
  v_fn  constant regprocedure := 'public.get_posting_preview(text,uuid)'::regprocedure;
  v_def text;
  v_new text;
  v_marker constant text := '/* cash-from-default-bank */';
  v_old constant text :=
    'SELECT id, name, code INTO v_cash_account FROM public.gl_accounts WHERE id = v_settings.cash_account_id;';
  v_repl constant text :=
    '/* cash-from-default-bank */
    SELECT g.id, g.name, g.code INTO v_cash_account
    FROM public.bank_accounts ba
    JOIN public.gl_accounts g ON g.id = ba.gl_account_id
    WHERE ba.company_id = v_company_id
      AND ba.is_default
      AND ba.is_active
    ORDER BY ba.created_at
    LIMIT 1;
    IF v_cash_account.id IS NULL THEN
        SELECT id, name, code INTO v_cash_account FROM public.gl_accounts WHERE id = v_settings.cash_account_id;
    END IF;';
begin
  v_def := pg_get_functiondef(v_fn);

  if position(v_marker in v_def) > 0 then
    raise notice 'get_posting_preview already resolves cash from the default bank account; nothing to do';
    return;
  end if;

  if position(v_old in v_def) = 0 then
    raise exception 'get_posting_preview: expected cash-account lookup not found; function differs from the reviewed version, aborting';
  end if;

  v_new := replace(v_def, v_old, v_repl);
  execute v_new;
  raise notice 'get_posting_preview now posts cash/bank lines to the default bank account GL';
end $$;
