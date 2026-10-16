-- Notification Monitor: indexes for date-bounded, per-channel queries.
--
-- The Monitor now filters by organization, channel and a date range in the
-- database before paginating. These indexes match those predicates and the
-- created_at DESC ordering. Performance only: no data, columns, policies or
-- grants change, and the app works without them (queries are just slower).
--
-- Safe to re-run (IF NOT EXISTS). Plain CREATE INDEX briefly blocks writes to
-- each table while it builds; run outside peak hours. To avoid the write lock,
-- run each statement separately with CREATE INDEX CONCURRENTLY instead (not
-- inside a transaction block).

CREATE INDEX IF NOT EXISTS idx_notif_outbox_org_channel_created
    ON public.notifications_outbox USING btree (org_id, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notif_logs_org_channel_created
    ON public.notification_logs USING btree (org_id, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_events_channel_created
    ON public.notification_events USING btree (channel, created_at DESC);
