import { NextRequest } from "next/server";
import { assertDestructiveOpsAllowed } from '@/lib/server/destructive-ops-guard'
import { deletionExecute, deletionPreview, isUuid } from '@/lib/identity/permanent-deletion'

// Configure route to be dynamic
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Each identity is previewed and deleted in its own database transaction (10 minutes for large batches)
export const maxDuration = 600;

const MAX_USERS = 500;
const CONCURRENCY = 3; // per-identity transactions take row and table locks; keep contention low
const KEEP_ALIVE_INTERVAL = 10000; // Send keep-alive ping every 10 seconds

/** Typed batch confirmation: the caller must state how many accounts they are deleting. */
const bulkConfirmationPhrase = (count: number) => `DELETE ${count} USERS`

type Outcome = { id: string; result: 'deleted' | 'blocked' | 'not_authorized' | 'not_found' | 'failed'; detail?: string }

/**
 * POST /api/admin/bulk-delete-users — guarded staging tool (env gate +
 * platform.data.destructive in assertDestructiveOpsAllowed).
 *
 * Body: { userIds: string[], reason: string, confirmation: "DELETE <n> USERS" }
 *
 * Every account goes through the canonical permanent identity deletion
 * (lib/identity/permanent-deletion.ts → identity_deletion_preview / _execute),
 * one transaction per identity: explicit platform.identity.delete for that
 * person's organization, protections, dependency blockers re-checked under
 * lock, durable record, login verified gone. Nothing is cleaned up, nulled or
 * re-assigned here: an account with business or audit history is reported as
 * blocked and left untouched (archive it instead).
 */
export async function POST(request: NextRequest) {
    // Centralized environment + auth + destructive-operation guard (checked before streaming starts)
    const guard = await assertDestructiveOpsAllowed(request, 'bulk-delete-users')
    if (guard.blocked) return guard.response

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const sendEvent = (type: string, data: any) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
            };
            const keepAliveInterval = setInterval(() => {
                sendEvent("ping", { timestamp: Date.now() });
            }, KEEP_ALIVE_INTERVAL);
            const finish = (type: string, data: any) => {
                clearInterval(keepAliveInterval);
                sendEvent(type, data);
                controller.close();
            };

            try {
                const body = await request.json().catch(() => ({}));
                const { userIds, reason, confirmation } = body ?? {};
                // The caller is the verified session user from the guard (never a body field).
                const callerId = guard.userId as string;

                if (!Array.isArray(userIds) || userIds.length === 0) {
                    return finish("error", { message: "No user IDs provided" });
                }
                const ids: string[] = Array.from(new Set(userIds.filter(isUuid)));
                if (ids.length !== userIds.length) {
                    return finish("error", { message: "User IDs must be distinct UUIDs" });
                }
                if (ids.length > MAX_USERS) {
                    return finish("error", { message: `At most ${MAX_USERS} users per request` });
                }
                if (typeof reason !== 'string' || reason.trim().length < 10) {
                    return finish("error", { message: "Enter a reason of at least 10 characters" });
                }
                if (typeof confirmation !== 'string' || confirmation.trim() !== bulkConfirmationPhrase(ids.length)) {
                    return finish("error", { message: `Type "${bulkConfirmationPhrase(ids.length)}" to confirm` });
                }

                const total = ids.length;
                sendEvent("init", { total, message: `Checking and deleting ${total} users one at a time...` });

                const outcomes: Outcome[] = [];
                const deleteOne = async (id: string): Promise<Outcome> => {
                    const preview = await deletionPreview(callerId, id, 'user_management');
                    if (!preview.ok) {
                        const result = preview.status === 403 ? 'not_authorized' : preview.status === 404 ? 'not_found' : 'failed';
                        return { id, result, detail: preview.message };
                    }
                    if (!preview.preview.allowed) {
                        return { id, result: 'blocked', detail: preview.preview.blockers.map(b => b.message || b.code).join(' ') };
                    }
                    const executed = await deletionExecute({
                        actorId: callerId,
                        userId: id,
                        entry: 'user_management',
                        requestId: crypto.randomUUID(),
                        previewToken: preview.preview.preview_token,
                        reason: `Bulk deletion: ${reason.trim()}`,
                        // The batch phrase was typed by the caller; per identity the server supplies the phrase it just previewed.
                        confirmation: preview.preview.confirmation_phrase,
                    });
                    if (!executed.ok) return { id, result: executed.status === 403 ? 'not_authorized' : 'failed', detail: executed.message };
                    if (executed.outcome.status === 'completed') return { id, result: 'deleted' };
                    if (executed.outcome.status === 'blocked') {
                        return { id, result: 'blocked', detail: executed.outcome.blockers.map(b => b.message || b.code).join(' ') };
                    }
                    return { id, result: 'failed', detail: 'Changed since the preview; nothing was deleted.' };
                };

                for (let i = 0; i < ids.length; i += CONCURRENCY) {
                    const batch = ids.slice(i, i + CONCURRENCY);
                    outcomes.push(...await Promise.all(batch.map(id => deleteOne(id).catch(() => ({ id, result: 'failed', detail: 'Unexpected error' }) as Outcome))));
                    const deleted = outcomes.filter(o => o.result === 'deleted').length;
                    sendEvent("progress", {
                        current: outcomes.length,
                        total,
                        progress: Math.min(99, Math.round((outcomes.length / total) * 100)),
                        success: deleted,
                        errors: outcomes.length - deleted,
                        message: `Processed ${outcomes.length}/${total} users (${deleted} deleted)...`,
                    });
                }

                const count = (result: Outcome['result']) => outcomes.filter(o => o.result === result).length;
                finish("complete", {
                    success: true,
                    summary: {
                        total,
                        success: count('deleted'),
                        error: total - count('deleted'),
                        blocked: count('blocked'),
                        notAuthorized: count('not_authorized'),
                        notFound: count('not_found'),
                        failed: count('failed'),
                    },
                    // Kept accounts and why (deleted ids are listed too, for the operator's log).
                    results: outcomes,
                });
            } catch (error: any) {
                console.error("Bulk delete error:", error);
                finish("error", { message: "Bulk deletion stopped. Accounts already reported as deleted are deleted; nothing else was changed." });
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
