-- User Account Created: expose SMS in Notification Types so the message is edited in the UI.

INSERT INTO public.notification_types (
  category, event_code, event_name, event_description,
  default_enabled, available_channels, is_system, sort_order
)
VALUES (
  'user',
  'user_created',
  'User Account Created',
  'Notifies new user of account creation. SMS copy is edited in Notification Types templates.',
  true,
  ARRAY['email', 'sms'],
  false,
  14
)
ON CONFLICT (event_code) DO UPDATE SET
  category = EXCLUDED.category,
  event_name = EXCLUDED.event_name,
  event_description = EXCLUDED.event_description,
  available_channels = EXCLUDED.available_channels,
  is_system = EXCLUDED.is_system,
  sort_order = EXCLUDED.sort_order;
