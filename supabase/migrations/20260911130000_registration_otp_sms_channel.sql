-- Consumer registration OTP: add SMS alongside email in Notification Types.
-- Message copy is edited in the Templates tab and used on send.

INSERT INTO public.notification_types (
  category, event_code, event_name, event_description,
  default_enabled, available_channels, is_system, sort_order
)
VALUES (
  'security',
  'registration_otp',
  'Registration OTP (Consumer)',
  'Sends a one-time code by email or SMS when a consumer creates an account from Collect Points / loyalty signup. Message copy comes from Notification Types templates.',
  true,
  ARRAY['email', 'sms'],
  true,
  24
)
ON CONFLICT (event_code) DO UPDATE SET
  category = EXCLUDED.category,
  event_name = EXCLUDED.event_name,
  event_description = EXCLUDED.event_description,
  default_enabled = EXCLUDED.default_enabled,
  available_channels = EXCLUDED.available_channels,
  is_system = EXCLUDED.is_system,
  sort_order = EXCLUDED.sort_order;
