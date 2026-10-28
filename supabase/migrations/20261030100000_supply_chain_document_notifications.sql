-- =============================================================================
-- Supply Chain document notifications: context ids, acknowledgement events,
-- SMS, de-duplication and non-blocking queueing
-- File: supabase/migrations/20261030100000_supply_chain_document_notifications.sql
-- Supersedes supabase/proposals/20261027_supply_chain_document_notifications.PROPOSAL.sql
-- (that file is now a pointer only — do not run it).
-- =============================================================================
-- Changes
--   1. public.trigger_document_notification() is replaced (owner, ACL,
--      SECURITY DEFINER and search_path are kept by CREATE OR REPLACE and
--      asserted below).
--        * Payload keeps every existing key (doc_type, doc_no, order_no,
--          issued_by, issued_to) and adds document_id, order_id, order_type,
--          issued_by_org_id, issued_to_org_id, display_order_no.
--        * INSERT (unchanged mapping): po_created, invoice_created,
--          receipt_issued (and the *_acknowledged / payment_received codes if a
--          document is inserted already acknowledged).
--        * UPDATE pending -> acknowledged only: PO -> po_acknowledged,
--          INVOICE -> invoice_acknowledged, PAYMENT -> payment_received.
--          Any other transition (acknowledged -> completed, no-op updates,
--          PAYMENT_REQUEST, SO, DO, RECEIPT) queues nothing.
--        * Once per document per event: if the outbox already holds that event
--          for that document_id, nothing is queued again.
--        * Offers whatsapp, sms and email to public.queue_notification, which
--          still queues only channels in notification_settings.channels_enabled
--          of an enabled setting with an active provider (unchanged function).
--        * A queueing error no longer rolls back the document change: it is
--          caught, raised as a WARNING (Postgres log) and no row is queued for
--          that event. This matches queue_notification's own rule ("log warning
--          instead of raising exception to prevent blocking transactions").
--        * A document whose parent order cannot be read queues nothing and
--          raises a WARNING.
--   2. New trigger trigger_document_ack_notification
--      AFTER UPDATE OF status ON public.documents
--      WHEN (OLD.status IS DISTINCT FROM NEW.status).
--
-- Not changed: public.queue_notification, every other trigger on documents,
-- notification_settings, notification_types, notifications_outbox rows, any
-- permission, grant or policy. Nothing already queued is replayed; only future
-- INSERTs/UPDATEs are affected.
--
-- Prerequisite: run as the owner of public.trigger_document_notification()
-- (CREATE OR REPLACE requires it). The preflight file reports the owner.
-- Safe to re-run. Any failed assertion rolls everything back.
-- This SQL does not choose recipients: "Related organization" and the other
-- recipient rules run in the outbox worker of the deployed application.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Prerequisites — nothing has been changed yet.
DO $pre$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.documents') IS NULL OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.notifications_outbox') IS NULL OR to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'documents, orders, organizations and notifications_outbox must exist';
  END IF;

  -- pg_attribute, not information_schema: the latter hides columns the current role cannot read.
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['id','order_id','doc_type','doc_no','status','company_id','issued_by_org_id','issued_to_org_id']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = 'public.documents'::regclass AND attname = c AND attnum > 0 AND NOT attisdropped);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'documents is missing column(s): %', v_missing; END IF;

  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['id','order_no','display_doc_no','order_type']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = 'public.orders'::regclass AND attname = c AND attnum > 0 AND NOT attisdropped);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'orders is missing column(s): %', v_missing; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.notifications_outbox'::regclass AND attname = 'payload_json'
                    AND atttypid = 'jsonb'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'notifications_outbox.payload_json (jsonb) is required';
  END IF;

  SELECT string_agg(v, ', ') INTO v_missing
    FROM unnest(ARRAY['pending','acknowledged']) AS v
   WHERE NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                      WHERE t.typname = 'document_status' AND e.enumlabel = v);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'document_status enum is missing: %', v_missing; END IF;

  IF to_regprocedure('public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamptz) is required';
  END IF;
  IF to_regprocedure('public.trigger_document_notification()') IS NULL THEN
    RAISE EXCEPTION 'public.trigger_document_notification() is expected to exist already';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.documents'::regclass AND tgname = 'trigger_document_notification' AND NOT tgisinternal
                    AND tgfoid = 'public.trigger_document_notification()'::regprocedure) THEN
    RAISE EXCEPTION 'trigger trigger_document_notification on documents is expected to exist and call trigger_document_notification()';
  END IF;
  IF NOT pg_has_role(current_user, (SELECT proowner FROM pg_proc WHERE oid = 'public.trigger_document_notification()'::regprocedure), 'MEMBER') THEN
    RAISE EXCEPTION 'run as the owner of trigger_document_notification() (%), not %',
      (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.trigger_document_notification()'::regprocedure), current_user;
  END IF;
END
$pre$;

-- 2. Snapshot of everything that must not change.
CREATE TEMP TABLE _dn_before ON COMMIT DROP AS
  SELECT 'function' AS kind, p.oid::regprocedure::text AS name,
         pg_get_userbyid(p.proowner) || '|' || COALESCE(p.proacl::text, '<default>') || '|' || p.prosecdef::text
           || '|' || COALESCE(array_to_string(p.proconfig, ','), '') || '|' || p.provolatile::text AS fingerprint
    FROM pg_proc p
   WHERE p.oid IN ('public.trigger_document_notification()'::regprocedure,
                   'public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamp with time zone)'::regprocedure)
  UNION ALL
  SELECT 'queue_notification body', 'queue_notification', md5(p.prosrc)
    FROM pg_proc p
   WHERE p.oid = 'public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamp with time zone)'::regprocedure
  UNION ALL
  SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.documents'::regclass AND NOT t.tgisinternal
     AND t.tgname <> 'trigger_document_ack_notification'
  UNION ALL
  SELECT 'table acl', c.relname, COALESCE(c.relacl::text, '<default>') || '|' || c.relrowsecurity::text
    FROM pg_class c
   WHERE c.oid IN ('public.documents'::regclass, 'public.notifications_outbox'::regclass)
  UNION ALL
  SELECT 'data', 'notification_settings',
         count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), ''))
    FROM public.notification_settings s
  UNION ALL
  SELECT 'data', 'notification_types',
         count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY t.event_code), ''))
    FROM public.notification_types t;

-- 3. The trigger function.
CREATE OR REPLACE FUNCTION public.trigger_document_notification() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_event_code TEXT;
  v_order RECORD;
  v_payload JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event_code := CASE
      WHEN NEW.doc_type = 'PO' AND NEW.status = 'pending' THEN 'po_created'
      WHEN NEW.doc_type = 'PO' AND NEW.status = 'acknowledged' THEN 'po_acknowledged'
      WHEN NEW.doc_type = 'INVOICE' AND NEW.status = 'pending' THEN 'invoice_created'
      WHEN NEW.doc_type = 'INVOICE' AND NEW.status = 'acknowledged' THEN 'invoice_acknowledged'
      WHEN NEW.doc_type = 'PAYMENT' AND NEW.status = 'acknowledged' THEN 'payment_received'
      WHEN NEW.doc_type = 'RECEIPT' THEN 'receipt_issued'
      ELSE NULL
    END;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Acknowledgement is an UPDATE of an existing pending document. Only that
    -- transition is an event; repeats and no-op updates are not.
    IF OLD.status::text = 'pending' AND NEW.status::text = 'acknowledged' THEN
      v_event_code := CASE NEW.doc_type::text
        WHEN 'PO' THEN 'po_acknowledged'
        WHEN 'INVOICE' THEN 'invoice_acknowledged'
        WHEN 'PAYMENT' THEN 'payment_received'
        ELSE NULL
      END;
    END IF;
  END IF;

  IF v_event_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT o.order_no, o.display_doc_no, o.order_type
    INTO v_order
    FROM public.orders o
   WHERE o.id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE WARNING 'trigger_document_notification: % for document % not queued: parent order % not found',
      v_event_code, NEW.id, NEW.order_id;
    RETURN NEW;
  END IF;

  -- One notification per document per event, however the row got here.
  IF EXISTS (
    SELECT 1 FROM public.notifications_outbox ob
     WHERE ob.org_id = NEW.company_id
       AND ob.event_code = v_event_code
       AND ob.payload_json @> jsonb_build_object('document_id', NEW.id)
  ) THEN
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'doc_type', NEW.doc_type,
    'doc_no', NEW.doc_no,
    'order_no', v_order.order_no,
    'issued_by', (SELECT org_name FROM public.organizations WHERE id = NEW.issued_by_org_id),
    'issued_to', (SELECT org_name FROM public.organizations WHERE id = NEW.issued_to_org_id),
    'document_id', NEW.id,
    'order_id', NEW.order_id,
    'order_type', v_order.order_type,
    'issued_by_org_id', NEW.issued_by_org_id,
    'issued_to_org_id', NEW.issued_to_org_id,
    'display_order_no', COALESCE(v_order.display_doc_no, v_order.order_no)
  );

  -- Notifications must not block the business change. Every channel for this
  -- event is queued together or not at all; a failure is logged, not hidden.
  BEGIN
    PERFORM public.queue_notification(
      NEW.company_id, v_event_code, c.channel, NULL, NULL, NULL, v_payload, 'normal', NULL
    )
    FROM unnest(ARRAY['whatsapp', 'sms', 'email']) AS c(channel);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trigger_document_notification: % for document % not queued (% %); the document change was kept',
      v_event_code, NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trigger_document_notification() IS
  'Queues Supply Chain document notifications: on INSERT (created/issued) and on pending->acknowledged UPDATE (po_acknowledged, invoice_acknowledged, payment_received). Payload carries document/order ids for recipient resolution. Once per document per event. queue_notification gates channels by saved settings and providers. Queue errors are logged as WARNING and do not roll back the document change.';

-- 4. The acknowledgement trigger.
DROP TRIGGER IF EXISTS trigger_document_ack_notification ON public.documents;
CREATE TRIGGER trigger_document_ack_notification
  AFTER UPDATE OF status ON public.documents
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trigger_document_notification();

-- 5. Post-checks — any failure rolls the whole file back.
DO $post$
DECLARE
  v_problem text;
BEGIN
  SELECT string_agg(b.kind || ' ' || b.name, ', ') INTO v_problem
    FROM _dn_before b
    LEFT JOIN (
      SELECT 'function' AS kind, p.oid::regprocedure::text AS name,
             pg_get_userbyid(p.proowner) || '|' || COALESCE(p.proacl::text, '<default>') || '|' || p.prosecdef::text
               || '|' || COALESCE(array_to_string(p.proconfig, ','), '') || '|' || p.provolatile::text AS fingerprint
        FROM pg_proc p
       WHERE p.oid IN ('public.trigger_document_notification()'::regprocedure,
                       'public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamp with time zone)'::regprocedure)
      UNION ALL
      SELECT 'queue_notification body', 'queue_notification', md5(p.prosrc)
        FROM pg_proc p
       WHERE p.oid = 'public.queue_notification(uuid,text,text,text,text,text,jsonb,text,timestamp with time zone)'::regprocedure
      UNION ALL
      SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
        FROM pg_trigger t
       WHERE t.tgrelid = 'public.documents'::regclass AND NOT t.tgisinternal
         AND t.tgname <> 'trigger_document_ack_notification'
      UNION ALL
      SELECT 'table acl', c.relname, COALESCE(c.relacl::text, '<default>') || '|' || c.relrowsecurity::text
        FROM pg_class c
       WHERE c.oid IN ('public.documents'::regclass, 'public.notifications_outbox'::regclass)
      UNION ALL
      SELECT 'data', 'notification_settings',
             count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), ''))
        FROM public.notification_settings s
      UNION ALL
      SELECT 'data', 'notification_types',
             count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY t.event_code), ''))
        FROM public.notification_types t
    ) a ON a.kind = b.kind AND a.name = b.name
   WHERE a.fingerprint IS DISTINCT FROM b.fingerprint;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'changed but must be preserved: %', v_problem;
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.documents'::regclass AND NOT tgisinternal
         AND tgfoid = 'public.trigger_document_notification()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'expected exactly two triggers calling trigger_document_notification() (insert + acknowledgement)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.documents'::regclass
       AND t.tgname = 'trigger_document_ack_notification'
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE OF status ON public.documents FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status))%'
  ) THEN
    RAISE EXCEPTION 'trigger_document_ack_notification is not installed as expected';
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.trigger_document_notification()'::regprocedure)
       NOT LIKE '%pending%acknowledged%document_id%EXCEPTION WHEN OTHERS%' THEN
    RAISE EXCEPTION 'trigger_document_notification() body is not the expected version';
  END IF;

  RAISE NOTICE 'supply chain document notifications: all post-checks passed';
END
$post$;

COMMIT;
