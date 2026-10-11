import { userAllowed } from '@/lib/security-access/operation'
/**
 * POST /api/module-assistant/chat/stream
 *
 * SSE streaming endpoint for Module Assistant (Finance, Supply Chain, Customer & Growth).
 * Uses intent-based smart DB tools to answer questions directly from the database.
 * Falls back to streaming LLM for general/complex queries.
 *
 * SSE event types:
 *   - token:  { t: "partial text" }
 *   - meta:   { mode, intent, lang, suggestions, cards }
 *   - done:   { reply (full), metrics }
 *   - error:  { error: "message" }
 *   - fast:   { reply, ... } (greeting/tool fast-path — complete response, no streaming)
 */
import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveProviderConfig } from '@/lib/server/ai/providerSettings'
import { logAiUsage } from '@/lib/server/ai/usageLogger'
import { streamOllamaChat } from '@/lib/ai/providers/ollama-stream'
import { recordMetric, estimateTokens } from '@/lib/ai/metrics'
import { ensureWarm, touchLastRequest } from '@/lib/ai/warmup'
import type { AiProvider } from '@/lib/ai/types'
import { detectCGIntent, executeCGTool, CG_SUGGESTIONS } from '@/lib/server/module-assistant/tools-customer-growth'
import { detectFinIntent, executeFinTool, FIN_SUGGESTIONS } from '@/lib/server/module-assistant/tools-finance'
import { detectSCIntent, executeAuthorizedSCTool, SC_SUGGESTIONS } from '@/lib/server/module-assistant/tools-supply-chain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Module config ─────────────────────────────────────────────────

type ModuleId = 'finance' | 'supply-chain' | 'customer-growth'

const MODULE_LABELS: Record<ModuleId, string> = {
  finance: 'Finance',
  'supply-chain': 'Supply Chain',
  'customer-growth': 'Customer & Growth',
}

function getSuggestions(moduleId: ModuleId) {
  switch (moduleId) {
    case 'finance': return FIN_SUGGESTIONS
    case 'supply-chain': return SC_SUGGESTIONS
    case 'customer-growth': return CG_SUGGESTIONS
  }
}

/** Detect intent and execute tool for a module */
async function tryToolExecution(moduleId: ModuleId, message: string, supabase: any, orgId: string, actor: { userId: string; organizationId: string }) {
  switch (moduleId) {
    case 'finance': {
      const { tool } = detectFinIntent(message)
      if (tool) return { tool, result: await executeFinTool(tool, supabase, orgId) }
      return null
    }
    case 'supply-chain': {
      const { tool } = detectSCIntent(message)
      if (tool) return { tool, result: await executeAuthorizedSCTool(tool, supabase, orgId, actor) }
      return null
    }
    case 'customer-growth': {
      const { tool } = detectCGIntent(message)
      if (tool) return { tool, result: await executeCGTool(tool, supabase, orgId) }
      return null
    }
  }
}

// ─── Fast-path greetings ───────────────────────────────────────────

const GREETING_RE = /^\s*(hi|hello|hey|helo|hye|yo|salam|assalamualaikum|morning|pagi|petang|malam|good\s*(morning|afternoon|evening)|apa\s*khabar|how\s*are\s*you|what'?s?\s*up|nak\s*tanya|boleh\s*tanya|saya\s*nak\s*tanya|i\s*want\s*to\s*ask)\s*[!?.…]*\s*$/i

const GREETINGS_EN = [
  'Hey there! 👋 How can I help you today?',
  'Hi! 😊 What would you like to know?',
  'Hello! Ready to help — just ask!',
]
const GREETINGS_MS = [
  'Hai! 👋 Nak tanya apa hari ni?',
  'Hello! 😊 Boleh bantu apa?',
  'Salam! Saya sedia membantu!',
]

// ─── Rate Limit ────────────────────────────────────────────────────

const rl = new Map<string, { count: number; resetAt: number }>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const entry = rl.get(userId)
  if (!entry || now > entry.resetAt) {
    rl.set(userId, { count: 1, resetAt: now + 60_000 })
    return false
  }
  if (entry.count >= 20) return true
  entry.count++
  return false
}

// ─── SSE helpers ───────────────────────────────────────────────────

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}
function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

type Lang = 'ms' | 'en'
function detectLang(text: string): Lang {
  const ms = /\b(saya|nak|macam|mana|berapa|ramai|ada|tak|buat|apa|ini|itu|tolong|boleh|cari|semua|dalam|untuk|dengan|kenapa|bagaimana)\b/i
  return ms.test(text) ? 'ms' : 'en'
}
function shortPrompt(modLabel: string, lang: Lang, dbCtx: string): string {
  const ln = lang === 'ms' ? 'Jawab dalam Bahasa Melayu. Santai tapi profesional.' : 'Reply in English. Casual but professional.'
  return `You are Serapod2U ${modLabel} Assistant. Be concise, warm, helpful. Use only provided context data. 1-4 sentences unless asked for detail. ${ln}${dbCtx}`
}

// ─── Handler ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const startMs = Date.now()
  try {
    const supabase = (await createClient()) as any
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user?.id) {
      return new Response(sseEvent('error', { error: 'Unauthorized' }), { status: 401, headers: sseHeaders() })
    }

    const { data: profile } = await supabase
      .from('users')
      .select('id, organization_id')
      .eq('id', user.id)
      .single()
    if (!profile?.organization_id) {
      return new Response(sseEvent('error', { error: 'Organization not found' }), { status: 400, headers: sseHeaders() })
    }
    if (!(await userAllowed(user.id, 'hr.ai.use', () => true, { organizationId: profile.organization_id }))) {
      return new Response(sseEvent('error', { error: 'Forbidden' }), { status: 403, headers: sseHeaders() })
    }
    const userId = profile.id as string
    const orgId = profile.organization_id as string

    if (rateLimited(userId)) {
      return new Response(sseEvent('error', { error: 'Too many requests. Please wait.' }), { status: 429, headers: sseHeaders() })
    }

    const body = await request.json().catch(() => null)
    if (!body?.message?.trim()) {
      return new Response(sseEvent('error', { error: 'Missing "message"' }), { status: 400, headers: sseHeaders() })
    }

    const moduleId = body.moduleId as ModuleId
    if (!moduleId || !MODULE_LABELS[moduleId]) {
      return new Response(sseEvent('error', { error: 'Invalid moduleId' }), { status: 400, headers: sseHeaders() })
    }

    const userMessage = body.message.trim()
    const conversationHistory: Array<{ role: string; content: string }> = body.history ?? []
    const requestedProvider = body.provider as AiProvider | undefined
    const lang = detectLang(userMessage)
    const suggestions = getSuggestions(moduleId)
    const modLabel = MODULE_LABELS[moduleId]

    // ── FAST PATH: greetings ─────────────────────────────────────
    if (userMessage.length <= 30 && GREETING_RE.test(userMessage)) {
      const pool = lang === 'ms' ? GREETINGS_MS : GREETINGS_EN
      const reply = pool[Math.floor(Math.random() * pool.length)]
      recordMetric({
        ts: new Date().toISOString(), provider: 'fast-path', model: '-',
        time_to_first_token_ms: 0, total_ms: Date.now() - startMs,
        tokens_out_estimate: estimateTokens(reply), error: null,
        mode: 'fast-path', user: userId.slice(0, 8),
      })
      return new Response(
        sseEvent('fast', {
          reply, lang, mode: 'ai', intent: 'casual', confidence: 'high',
          suggestions, cards: [],
          meta: { durationMs: Date.now() - startMs, fastPath: true },
        }),
        { status: 200, headers: sseHeaders() },
      )
    }

    // ── SMART TOOL PATH: try intent-based DB query first ─────────
    // Use admin client for tool queries to bypass RLS restrictions
    const adminForTools = createAdminClient()
    const resolvedOrgId = await resolveHqOrgId(adminForTools, orgId)
    const toolExec = await tryToolExecution(moduleId, userMessage, adminForTools, resolvedOrgId, { userId: user.id, organizationId: profile.organization_id })
    if (toolExec && toolExec.result.success) {
      const totalMs = Date.now() - startMs
      const reply = toolExec.result.summary
      recordMetric({
        ts: new Date().toISOString(), provider: 'db-tool', model: toolExec.tool,
        time_to_first_token_ms: 0, total_ms: totalMs,
        tokens_out_estimate: estimateTokens(reply), error: null,
        mode: 'tool', user: userId.slice(0, 8),
      })
      logAiUsage({ organizationId: orgId, userId, provider: 'db-tool', module: moduleId, model: toolExec.tool, responseMs: totalMs, status: 'success', messagePreview: userMessage })
      return new Response(
        sseEvent('fast', {
          reply, lang, mode: 'ai+tool', intent: toolExec.tool, confidence: 'high',
          suggestions, cards: toolExec.result.rows ? [{ title: toolExec.tool, rows: toolExec.result.rows }] : [],
          meta: { durationMs: totalMs, tool: toolExec.tool, totalCount: toolExec.result.totalCount },
        }),
        { status: 200, headers: sseHeaders() },
      )
    }

    // ── Resolve AI provider ──────────────────────────────────────
    const admin = createAdminClient()
    const resolvedConfig = await resolveProviderConfig(admin, orgId, requestedProvider)

    if (!resolvedConfig.enabled || resolvedConfig.provider !== 'ollama') {
      // Non-Ollama or disabled — try tool result even if partial, or offline fallback
      const fallbackReply = toolExec?.result?.summary
        || (lang === 'ms' ? `AI sedang offline. Sila cuba lagi nanti.` : `AI is currently offline. Please try again later.`)
      return new Response(
        sseEvent('fast', {
          reply: fallbackReply, lang, mode: 'offline', intent: 'general',
          confidence: 'low', suggestions,
          cards: toolExec?.result?.rows ? [{ title: 'Data', rows: toolExec.result.rows }] : [],
          meta: { durationMs: Date.now() - startMs, offline: true },
        }),
        { status: 200, headers: sseHeaders() },
      )
    }

    // ── Warmup + stream (general LLM query) ──────────────────────
    await ensureWarm()
    touchLastRequest()

    // If tool returned data (but maybe partial/error), include it as context
    const toolContext = toolExec?.result?.summary ? `\n\n--- DB DATA ---\n${toolExec.result.summary}\n--- END ---` : ''

    const messages = [
      { role: 'system', content: shortPrompt(modLabel, lang, toolContext) },
      ...conversationHistory.slice(-6),
      { role: 'user', content: userMessage },
    ]

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(sseEvent('meta', {
          lang, mode: toolContext ? 'ai+tool' : 'ai', intent: 'general',
          confidence: 'medium', suggestions, cards: [],
        })))

        try {
          let streamError = ''
          const result = await streamOllamaChat(
            { config: resolvedConfig, messages, model: resolvedConfig.model, options: { temperature: 0.3, top_p: 0.9, num_predict: 512 } },
            {
              onToken(token) { controller.enqueue(encoder.encode(sseEvent('token', { t: token }))) },
              onDone() { /* handled below */ },
              onError(err) { streamError = err; console.error('[Module Stream] Ollama error:', err) },
            },
          )

          const totalMs = Date.now() - startMs
          if (result.fullText) {
            controller.enqueue(encoder.encode(sseEvent('done', {
              reply: result.fullText,
              metrics: { total_ms: totalMs, time_to_first_token_ms: result.timeToFirstTokenMs, tokens_out_estimate: result.tokensOut },
            })))
            recordMetric({
              ts: new Date().toISOString(), provider: 'ollama', model: resolvedConfig.model ?? 'qwen2.5:3b',
              time_to_first_token_ms: result.timeToFirstTokenMs, total_ms: totalMs,
              tokens_out_estimate: result.tokensOut, error: null, mode: 'stream', user: userId.slice(0, 8),
            })
            logAiUsage({ organizationId: orgId, userId, provider: 'ollama', module: moduleId, model: resolvedConfig.model, responseMs: totalMs, status: 'success', messagePreview: userMessage })
          } else {
            const errDetail = streamError || result.error || 'Empty response from Ollama'
            console.error('[Module Stream] Empty response. Detail:', errDetail)
            controller.enqueue(encoder.encode(sseEvent('error', { error: errDetail })))
            recordMetric({
              ts: new Date().toISOString(), provider: 'ollama', model: resolvedConfig.model ?? 'qwen2.5:3b',
              time_to_first_token_ms: -1, total_ms: totalMs, tokens_out_estimate: 0,
              error: errDetail, mode: 'stream', user: userId.slice(0, 8),
            })
            logAiUsage({ organizationId: orgId, userId, provider: 'ollama', module: moduleId, model: resolvedConfig.model, responseMs: totalMs, status: 'error', errorMessage: errDetail, messagePreview: userMessage })
          }
          controller.close()
        } catch (err: any) {
          controller.enqueue(encoder.encode(sseEvent('error', { error: err.message })))
          controller.close()
        }
      },
    })

    return new Response(stream, { status: 200, headers: sseHeaders() })
  } catch (err: any) {
    console.error('[Module Assistant Stream] Error:', err)
    return new Response(sseEvent('error', { error: 'Internal server error' }), { status: 500, headers: sseHeaders() })
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Resolve the HQ organization ID for tool queries.
 * If the user belongs to a sub-org (DIST, WAREHOUSE, SHOP, etc.),
 * resolve up to the HQ that owns the orders/products.
 */
async function resolveHqOrgId(admin: any, orgId: string): Promise<string> {
  try {
    const { data: org } = await admin
      .from('organizations')
      .select('id, org_type_code, parent_org_id')
      .eq('id', orgId)
      .single()

    if (!org) return orgId

    // If already HQ, return as-is
    if (org.org_type_code === 'HQ') return orgId

    // If has parent_org_id, check if parent is HQ
    if (org.parent_org_id) {
      const { data: parent } = await admin
        .from('organizations')
        .select('id, org_type_code')
        .eq('id', org.parent_org_id)
        .single()
      if (parent?.org_type_code === 'HQ') return parent.id
    }

    // Fallback: find the HQ org in the system
    const { data: hq } = await admin
      .from('organizations')
      .select('id')
      .eq('org_type_code', 'HQ')
      .limit(1)
      .single()

    return hq?.id ?? orgId
  } catch {
    return orgId
  }
}

// (Smart DB tools now handle context fetching — see tools-*.ts files)
