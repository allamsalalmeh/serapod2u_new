-- TikTok Shop daily shipping report: two Notification Types under E-Commerce.
-- Both start switched off with no settings rows; channel and recipients are
-- chosen in Settings -> Notification Types. Catalog rows only, nothing else changes.

INSERT INTO public.notification_types (
  category, event_code, event_name, event_description,
  default_enabled, available_channels, is_system, sort_order
)
VALUES
  (
    'ecommerce',
    'tiktok_shop_daily_report',
    'TikTok Shop Daily Shipping Report',
    'Full packing list per TikTok shop at 9:35 am and 12:35 pm (parcels still to ship), and what shipped today at 6:35 pm. Choose the channel and recipients here.',
    false,
    ARRAY['email', 'whatsapp', 'sms'],
    false,
    10
  ),
  (
    'ecommerce',
    'tiktok_shop_daily_report_sms',
    'TikTok Shop Daily Shipping Summary (short)',
    'One-line parcel and item totals per TikTok shop, sent at the same times as the full report. Meant for SMS or WhatsApp.',
    false,
    ARRAY['sms', 'whatsapp'],
    false,
    11
  )
ON CONFLICT (event_code) DO UPDATE SET
  category = EXCLUDED.category,
  event_name = EXCLUDED.event_name,
  event_description = EXCLUDED.event_description,
  default_enabled = EXCLUDED.default_enabled,
  available_channels = EXCLUDED.available_channels,
  is_system = EXCLUDED.is_system,
  sort_order = EXCLUDED.sort_order;
