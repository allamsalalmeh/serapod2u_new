-- Staff alert for a paid Serapod2U Store / Outdoor website order, under E-Commerce.
-- Starts switched off with no settings rows; channel and recipients are chosen in
-- Settings -> Notification Types. Catalog row only, nothing else changes.

INSERT INTO public.notification_types (
  category, event_code, event_name, event_description,
  default_enabled, available_channels, is_system, sort_order
)
VALUES (
  'ecommerce',
  'storefront_order_paid',
  'New Paid Website Order (staff alert)',
  'Short alert to staff when a Serapod2U Store or Outdoor website order is paid. Only the recipients chosen here get it, never the customer.',
  false,
  ARRAY['sms', 'whatsapp'],
  false,
  12
)
ON CONFLICT (event_code) DO UPDATE SET
  category = EXCLUDED.category,
  event_name = EXCLUDED.event_name,
  event_description = EXCLUDED.event_description,
  default_enabled = EXCLUDED.default_enabled,
  available_channels = EXCLUDED.available_channels,
  is_system = EXCLUDED.is_system,
  sort_order = EXCLUDED.sort_order;
