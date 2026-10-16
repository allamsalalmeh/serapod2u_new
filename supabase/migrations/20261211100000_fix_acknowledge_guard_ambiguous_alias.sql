-- ============================================================================
-- Fix: "column reference d.issued_to_org_id is ambiguous" on acknowledgement
--
-- 20260928120000_sa_final_modules_supply_chain injected an S&A guard into
-- po_acknowledge, invoice_acknowledge and payment_acknowledge that reads
--   (SELECT d.issued_to_org_id FROM public.documents d WHERE d.id = p_document_id)
-- All three functions already DECLARE a variable `d public.documents`, so
-- PL/pgSQL cannot tell the table alias from the variable and every
-- acknowledgement fails before doing any work.
--
-- This rewrites only that subquery's alias (d -> sa_doc) in the live body.
-- The guard marker and everything else stay as they are. Idempotent: a
-- function that no longer contains the old text is left alone.
--
-- Rollback: not needed (the old text never ran successfully).
-- ============================================================================
do $$
declare
  v_fn regprocedure;
  v_def text;
  v_new text;
  v_old_guard constant text :=
    '(SELECT d.issued_to_org_id FROM public.documents d WHERE d.id = p_document_id)';
  v_new_guard constant text :=
    '(SELECT sa_doc.issued_to_org_id FROM public.documents sa_doc WHERE sa_doc.id = p_document_id)';
begin
  foreach v_fn in array array[
    'public.po_acknowledge(uuid)'::regprocedure,
    'public.invoice_acknowledge(uuid,text)'::regprocedure,
    'public.payment_acknowledge(uuid)'::regprocedure
  ] loop
    v_def := pg_get_functiondef(v_fn);
    v_new := replace(v_def, v_old_guard, v_new_guard);
    if v_new <> v_def then
      execute v_new;
      raise notice 'fixed acknowledge guard alias in %', v_fn;
    end if;
  end loop;
end $$;
