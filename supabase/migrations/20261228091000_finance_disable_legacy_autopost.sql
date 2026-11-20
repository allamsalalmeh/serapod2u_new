-- Finance: retire the legacy automatic posting
--
-- Two triggers on public.documents (trg_auto_post_document_to_gl and
-- trg_auto_post_document_status_change) posted documents to the GL by themselves
-- when gl_settings.posting_mode = 'AUTO', through _auto_post_document_to_gl_internal
-- and gl_posting_rules. That path predates the current posting engine: it knows
-- nothing about amounts actually paid or received, partial payments, document
-- closing, customer/supplier advances, cost of goods sold at base_cost or the
-- D2H/H2M split. Posting is done from Pending Postings only.
--
--   * Both triggers are dropped (their functions stay, unused).
--   * posting_mode is set to MANUAL and can no longer be changed.
--
-- Nothing is posted, reversed or deleted by this migration.

BEGIN;

DROP TRIGGER IF EXISTS trg_auto_post_document_to_gl ON public.documents;
DROP TRIGGER IF EXISTS trg_auto_post_document_status_change ON public.documents;

UPDATE public.gl_settings SET posting_mode = 'MANUAL' WHERE posting_mode IS DISTINCT FROM 'MANUAL';

ALTER TABLE public.gl_settings DROP CONSTRAINT IF EXISTS gl_settings_posting_mode_manual_only;
ALTER TABLE public.gl_settings
    ADD CONSTRAINT gl_settings_posting_mode_manual_only CHECK (posting_mode = 'MANUAL');

COMMENT ON COLUMN public.gl_settings.posting_mode IS
    'Always MANUAL: documents are posted from Pending Postings (legacy automatic posting retired).';

COMMIT;

-- Verification (read only)
SELECT posting_mode FROM public.gl_settings;
SELECT t.tgname AS remaining_autopost_triggers
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal AND p.proname ~ 'auto_post';
