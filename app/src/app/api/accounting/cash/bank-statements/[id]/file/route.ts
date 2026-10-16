import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  CASH_VIEW,
  STATEMENT_APPROVE,
  STATEMENT_BUCKET,
  STATEMENT_IMPORT,
  UUID_RE,
  loadStatementContext,
  safeFileName,
} from '@/lib/finance/bank-statements/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/cash/bank-statements/:id/file — download the original
 * statement file exactly as uploaded. The bucket is private with no browser
 * access; the server reads it with the service role after authorizing the
 * user and checks the SHA-256 recorded at upload before serving it.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Statement not found' }, { status: 404 })
    const ctx = await loadStatementContext()
    if ('error' in ctx) return ctx.error
    const { db, orgId, allowed } = ctx
    const [canView, canImport, canApprove] = await Promise.all([allowed(CASH_VIEW), allowed(STATEMENT_IMPORT), allowed(STATEMENT_APPROVE)])
    if (!canView && !canImport && !canApprove) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Read through the user's own client: RLS decides visibility.
    const { data: statement } = await db
      .from('bank_statement_imports')
      .select('id, file_name, file_path, file_sha256')
      .eq('id', id)
      .eq('company_id', orgId)
      .maybeSingle()
    if (!statement?.file_path) return NextResponse.json({ error: 'Original file not available' }, { status: 404 })

    const { data: blob, error } = await createAdminClient(30_000).storage.from(STATEMENT_BUCKET).download(statement.file_path)
    if (error || !blob) {
      console.error('Error reading bank statement file:', error)
      return NextResponse.json({ error: 'Original file not available' }, { status: 404 })
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== statement.file_sha256) {
      console.error('Bank statement file hash mismatch', { importId: id })
      return NextResponse.json({ error: 'The stored file does not match the uploaded original' }, { status: 409 })
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFileName(statement.file_name)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-SHA256': statement.file_sha256,
      },
    })
  } catch (error) {
    console.error('Error in bank statement file API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
