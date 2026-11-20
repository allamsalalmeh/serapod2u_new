-- ============================================================================
-- get_pending_notifications returns only rows the outbox worker can send.
-- ----------------------------------------------------------------------------
-- The worker claims a row with `status = 'queued'` and skips anything else
-- without changing it. The function also returned failed rows whose retry time
-- had come (and due 'scheduled' rows), oldest first, limited to p_limit. Once
-- p_limit such rows existed they filled every batch, so new queued messages
-- were never reached: on production nothing was sent from 2026-11-02 12:38 to
-- 2026-11-03 11:10 MYT (23 failed WhatsApp po_created rows held the 20 slots).
--
-- Failed rows were never retried by the worker, so returning only queued rows
-- changes no delivery behaviour; it only stops failures blocking the queue.
-- Same signature, return type, security and search_path as before.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_pending_notifications(p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, org_id uuid, event_code text, channel text, to_phone text, to_email text, template_code text, payload_json jsonb, priority text, provider_name text, retry_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    n.id,
    n.org_id,
    n.event_code,
    n.channel,
    n.to_phone,
    n.to_email,
    n.template_code,
    n.payload_json,
    n.priority,
    n.provider_name,
    n.retry_count
  FROM public.notifications_outbox n
  WHERE n.status = 'queued'
  ORDER BY
    CASE n.priority
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'normal' THEN 3
      WHEN 'low' THEN 4
    END,
    n.created_at ASC
  LIMIT p_limit
  FOR UPDATE SKIP LOCKED;
END;
$function$;

COMMIT;
