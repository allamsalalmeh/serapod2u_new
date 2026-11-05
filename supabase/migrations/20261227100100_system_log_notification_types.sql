-- ENH04-OR-001: System Log category under Platform & Settings in Notification Types.
-- Catalog rows only and switched off: no notification_settings rows are created, so nothing is sent until an
-- administrator enables a type and chooses its channel and recipients. Saved settings are not touched.
--
-- Present on staging since 2026-11-05 (verified from the catalog). Not applied on production. The Notification Types page also upserts these rows when opened.

INSERT INTO public.notification_types (
  category, event_code, event_name, event_description,
  default_enabled, available_channels, is_system, sort_order
)
VALUES
  ('system_log', 'system_error_critical', 'Critical System Error',
   'Alert when the application cannot reach or use a core service, such as a lost database connection. Sends a System Logs reference, never technical details. Starts off; recipients are chosen here.',
   false, ARRAY['whatsapp', 'sms', 'email'], false, 1),
  ('system_log', 'system_error_application', 'Application / API Error',
   'Alert for an unexpected application or API failure. Normal validation errors, wrong passwords and denied access never send this. Starts off; recipients are chosen here.',
   false, ARRAY['whatsapp', 'sms', 'email'], false, 2),
  ('system_log', 'system_error_database', 'Database Operation Failure',
   'Alert when a database operation fails unexpectedly, such as a rejected constraint. Sends a System Logs reference, never the database error. Starts off; recipients are chosen here.',
   false, ARRAY['whatsapp', 'sms', 'email'], false, 3)
ON CONFLICT (event_code) DO UPDATE SET
  category = EXCLUDED.category,
  event_name = EXCLUDED.event_name,
  event_description = EXCLUDED.event_description,
  default_enabled = EXCLUDED.default_enabled,
  available_channels = EXCLUDED.available_channels,
  is_system = EXCLUDED.is_system,
  sort_order = EXCLUDED.sort_order;
