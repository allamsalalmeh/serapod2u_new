import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
    hrResetEligibility, hrResetHistory, hrResetOrganizations, hrResetPreview, isHrResetKind, isUuid,
} from '@/lib/hr/data-reset'

// ─── GET  /api/hr/data-management                      ── organizations + eligibility (+ history)
// ─── POST /api/hr/data-management {organization_id, kind} ── reset preview
//
// Authorization is decided in the database for every call: Super Admin plus
// an explicit Security & Access grant of 'hr.data.reset' for the organization,
// and the organization's HR must be pre-go-live (hr_reset_actor_check /
// hr_reset_preview). The organization is always re-checked server-side.

const PERMISSION = 'hr.data.reset'

async function currentActor() {
    const supabase = (await createClient()) as any
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return null
    const { data: profile } = await supabase.from('users').select('id, organization_id').eq('id', user.id).single()
    return profile?.id ? { id: profile.id as string, organizationId: (profile.organization_id ?? null) as string | null } : null
}

export async function GET(request: NextRequest) {
    try {
        const actor = await currentActor()
        if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const own = actor.organizationId ? await hrResetEligibility(actor.id, actor.organizationId) : null
        if (own && !own.ok) {
            return NextResponse.json({ success: false, error: own.message, code: own.code }, { status: own.status })
        }
        const orgs = await hrResetOrganizations(actor.id)
        if (!orgs.ok) return NextResponse.json({ success: false, error: orgs.message, code: orgs.code }, { status: orgs.status })

        const requested = new URL(request.url).searchParams.get('organization_id')
        const selected = requested && orgs.organizations.some(o => o.id === requested)
            ? requested
            : (orgs.organizations.find(o => o.id === actor.organizationId)?.id ?? orgs.organizations[0]?.id ?? null)

        return NextResponse.json({
            success: true,
            data: {
                permission: PERMISSION,
                eligibility: own?.eligibility ?? null,
                organizations: orgs.organizations,
                selected_organization_id: selected,
                history: selected ? await hrResetHistory(selected) : [],
            },
        })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const actor = await currentActor()
        if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        const body = await request.json().catch(() => ({}))
        if (!isUuid(body.organization_id) || !isHrResetKind(body.kind)) {
            return NextResponse.json({ success: false, error: 'organization_id and kind (onboarding | full) are required' }, { status: 400 })
        }
        const preview = await hrResetPreview(actor.id, body.organization_id, body.kind)
        if (!preview.ok) return NextResponse.json({ success: false, error: preview.message, code: preview.code }, { status: preview.status })
        return NextResponse.json({ success: true, data: preview.preview })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
