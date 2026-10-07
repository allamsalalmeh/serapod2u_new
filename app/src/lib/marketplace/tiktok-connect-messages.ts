/** Result keys of the TikTok Shop connect/callback redirect (?tiktok=…) and their messages. */
export const TIKTOK_CONNECT_MESSAGES: Record<string, string> = {
  connected: 'TikTok Shop connected. Click "Sync now" to bring in orders, settlements and payouts.',
  not_configured: 'The TikTok Shop app is not set up on this server yet.',
  invalid: 'The TikTok authorization expired or did not match. Click Connect again.',
  denied: 'The authorization was cancelled in TikTok.',
  unauthorized: 'Sign in to Serapod2U and try again.',
  token: 'TikTok did not accept the authorization code. Click Connect again.',
  not_seller: 'This TikTok account is not a seller account.',
  no_shop: 'This TikTok account has no shop the app can read.',
  multiple_shops: 'This TikTok account has several shops and none matches the selected shop name.',
  wrong_shop: 'This TikTok account belongs to another shop in Serapod2U. Log in to the right TikTok account and connect again.',
  already_connected: 'This TikTok shop is already connected to another shop in Serapod2U.',
  error: 'Connecting to TikTok failed. Try again.',
}
