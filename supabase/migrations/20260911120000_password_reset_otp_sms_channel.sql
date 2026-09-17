-- Consumer password-reset OTP: add SMS alongside email in Notification Types.
-- SMS body is edited in the Templates tab and sent from that saved copy.

INSERT INTO public.notification_types (
  category, event_code, event_name, event_description,
  default_enabled, available_channels, is_system, sort_order
)
VALUES (
  'security',
  'password_reset_otp',
  'Password Reset OTP (Consumer)',
  'Sends a one-time code by email or SMS when a consumer resets password from Collect Points / loyalty or portal login. SMS copy comes from Notification Types templates.',
  true,
  ARRAY['email', 'sms'],
  true,
  25
)
ON CONFLICT (event_code) DO UPDATE SET
  category = EXCLUDED.category,
  event_name = EXCLUDED.event_name,
  event_description = EXCLUDED.event_description,
  default_enabled = EXCLUDED.default_enabled,
  available_channels = EXCLUDED.available_channels,
  is_system = EXCLUDED.is_system,
  sort_order = EXCLUDED.sort_order;
