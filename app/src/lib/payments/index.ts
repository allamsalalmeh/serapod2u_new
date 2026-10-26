// ── Payment Gateway Adapter Layer ──────────────────────────────────
// Central entry point for all payment providers.
// The active provider is read from the `payment_gateway_settings` table.
// Provider adapters live in ./providers/ folder.

import { createAdminClient } from '@/lib/supabase/admin'
import { toyyibPay } from './providers/toyyibpay'
import { billplz } from './providers/billplz-adapter'
import { stripe } from './providers/stripe-adapter'

// Re-export shared types so external consumers keep importing from here
export type {
  PaymentIntentInput,
  PaymentIntentResult,
  PaymentCallbackResult,
  PaymentProviderAdapter,
} from './types'

import type { PaymentIntentInput, PaymentIntentResult, PaymentCallbackResult, PaymentProviderAdapter } from './types'

// ── Provider Registry ─────────────────────────────────────────────

const providers: Record<string, PaymentProviderAdapter> = {
  toyyibpay: toyyibPay,
  billplz: billplz,
  stripe: stripe,
}

// ── Gateway Settings Cache (60s) ─────────────────────────────────

let gatewayCache: { data: any; ts: number } | null = null
const CACHE_TTL = 60_000

async function getActiveGateway() {
  if (gatewayCache && Date.now() - gatewayCache.ts < CACHE_TTL) {
    return gatewayCache.data
  }

  const supabase: any = createAdminClient()
  const { data, error } = await supabase
    .from('payment_gateway_settings')
    .select('*')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[payments] failed to load gateway settings:', error)
    return null
  }

  gatewayCache = { data, ts: Date.now() }
  return data
}

// ── Public API ────────────────────────────────────────────────────

function hasGatewayCredentials(provider: string, credentials: Record<string, string> | null | undefined) {
  const creds = credentials || {}
  if (provider === 'stripe') return Boolean(creds.secret_key)
  if (provider === 'billplz') return Boolean(creds.api_key && creds.collection_id)
  if (provider === 'toyyibpay') return Boolean(creds.secret_key && creds.category_code)
  return Object.keys(creds).length > 0
}

export function paymentMethodLabel(provider: string) {
  if (provider === 'billplz') return 'FPX / e-Wallet (Billplz)'
  if (provider === 'stripe') return 'Card / FPX / GrabPay'
  if (provider === 'toyyibpay') return 'FPX (ToyyibPay)'
  return provider
}

export async function listCheckoutPaymentMethods() {
  const supabase: any = createAdminClient()
  const { data, error } = await supabase
    .from('payment_gateway_settings')
    .select('provider, is_active, credentials')

  if (error || !data) {
    console.error('[payments] failed to list gateways:', error)
    return [] as { key: string; name: string; label: string; isDefault: boolean }[]
  }

  const seen = new Set<string>()
  return data
    .filter((row: any) => hasGatewayCredentials(row.provider, row.credentials))
    .filter((row: any) => {
      const key = String(row.provider)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((row: any) => ({
      key: String(row.provider),
      name: providers[row.provider]?.name || String(row.provider),
      label: paymentMethodLabel(String(row.provider)),
      isDefault: Boolean(row.is_active),
    }))
}

export async function createPaymentIntent(
  input: PaymentIntentInput,
  providerHint?: string | null,
): Promise<PaymentIntentResult> {
  const hinted = providerHint ? await getGatewayByProvider(providerHint) : null
  const gateway =
    hinted && hasGatewayCredentials(hinted.provider, hinted.credentials)
      ? hinted
      : await getActiveGateway()

  if (!gateway) {
    return {
      success: true,
      provider: 'manual',
      paymentRef: `MANUAL-${input.orderRef}`,
    }
  }

  const adapter = providers[gateway.provider]
  if (!adapter) {
    return {
      success: false,
      provider: gateway.provider,
      error: `Unknown payment provider: ${gateway.provider}`,
    }
  }

  const credentials = (gateway.credentials as Record<string, string>) || {}
  return adapter.createPayment(input, credentials)
}

export async function getGatewayByProvider(provider: string) {
  const supabase: any = createAdminClient()
  const { data, error } = await supabase
    .from('payment_gateway_settings')
    .select('*')
    .eq('provider', provider)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[payments] failed to load gateway for', provider, error)
    return null
  }
  return data
}

export async function verifyPaymentCallback(
  providerHint: string,
  payload: Record<string, string>,
): Promise<PaymentCallbackResult> {
  const providerKey = providerHint || (await getActiveGateway())?.provider || 'unknown'
  const adapter = providers[providerKey]

  if (!adapter) {
    return { verified: false, orderId: '', paid: false, error: `Unknown provider: ${providerKey}` }
  }

  const gateway = (await getGatewayByProvider(providerKey)) || (await getActiveGateway())
  const credentials = (gateway?.credentials as Record<string, string>) || {}
  return adapter.verifyCallback(payload, credentials)
}
