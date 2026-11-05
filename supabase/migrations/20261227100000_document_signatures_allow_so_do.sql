-- ENH04-OR-001: Sales Order and Delivery Order acknowledgement.
--
-- POST /api/documents/[documentId]/acknowledge records SO and DO acknowledgements with add_document_signature(), which
-- inserts documents.doc_type into document_signatures.document_type. The CHECK only lists PO, INVOICE, PAYMENT and RECEIPT,
-- so every SO/DO acknowledgement fails with document_signatures_document_type_check and the document stays pending.
--
-- This keeps an explicit list and adds only the two types that route signs. PAYMENT_REQUEST is not signed and stays out.
-- Existing rows all satisfy the wider list. Signature access (RLS, the no-direct-write policies) goes by document, not by
-- type, so nothing else changes.
--
-- Applied on staging by 2026-11-05 (verified from the catalog). Not applied on production. Apply once per environment, in one transaction.

BEGIN;

ALTER TABLE public.document_signatures
  DROP CONSTRAINT IF EXISTS document_signatures_document_type_check;

ALTER TABLE public.document_signatures
  ADD CONSTRAINT document_signatures_document_type_check
  CHECK (document_type = ANY (ARRAY['PO'::text, 'SO'::text, 'DO'::text, 'INVOICE'::text, 'PAYMENT'::text, 'RECEIPT'::text]));

COMMIT;

-- Rollback (only while no SO/DO signature exists; check first with
--   SELECT count(*) FROM public.document_signatures WHERE document_type IN ('SO','DO');):
--   ALTER TABLE public.document_signatures DROP CONSTRAINT document_signatures_document_type_check;
--   ALTER TABLE public.document_signatures ADD CONSTRAINT document_signatures_document_type_check
--     CHECK (document_type = ANY (ARRAY['PO'::text, 'INVOICE'::text, 'PAYMENT'::text, 'RECEIPT'::text]));
