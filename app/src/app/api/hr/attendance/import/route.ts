import { NextRequest } from 'next/server'
import { importBatch, importBatches, importCancel, importCommit, importPreview, invalid, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isUuid } from '@/lib/hr/wave3/messages'
import { IMPORT_MAX_ROWS } from '@/lib/hr/wave3/attendance-import'

/**
 * Excel bulk attendance import (Wave 3, B4c). Explicit HR ('hr.attendance.manage') in the target company.
 *
 * GET  [?batch_id] — recent imports, or one batch with its per-row outcomes
 * POST { action: 'preview', file_name, file_sha256, rows: [...] , organization_id? } — validates every row in the
 *      database (canonical employee mapping, formats, duplicates, conflicts); writes nothing to attendance
 * POST { action: 'commit', batch_id, expected_valid } — imports the valid rows after re-validation; idempotent
 * POST { action: 'cancel', batch_id }
 * The same file (SHA-256) can be committed only once per company.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const batch = q.get('batch_id')
    if (batch) {
        if (!isUuid(batch)) return invalid()
        return respond(await importBatch(actor.id, batch))
    }
    const org = q.get('organization_id') ?? actor.organizationId
    if (!isUuid(org)) return invalid()
    return respond(await importBatches(actor.id, org))
}

export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const b = await request.json().catch(() => ({}))
    if (b?.action === 'preview') {
        const org = b.organization_id ?? actor.organizationId
        if (!isUuid(org) || typeof b.file_name !== 'string' || !b.file_name.trim() || typeof b.file_sha256 !== 'string'
            || !/^[0-9a-f]{64}$/.test(b.file_sha256) || !Array.isArray(b.rows)) return invalid()
        if (b.rows.length === 0) return invalid('The file contains no attendance rows.', 'EMPTY_FILE')
        if (b.rows.length > IMPORT_MAX_ROWS) return invalid(`A file can hold at most ${IMPORT_MAX_ROWS.toLocaleString()} rows.`, 'TOO_MANY_ROWS')
        return respond(await importPreview(actor.id, org, b.file_name.trim().slice(0, 200), b.file_sha256, b.rows))
    }
    if (b?.action === 'commit') {
        if (!isUuid(b.batch_id) || !Number.isInteger(b.expected_valid)) return invalid()
        return respond(await importCommit(actor.id, b.batch_id, b.expected_valid))
    }
    if (b?.action === 'cancel') {
        if (!isUuid(b.batch_id)) return invalid()
        return respond(await importCancel(actor.id, b.batch_id))
    }
    return invalid('Invalid action')
}
