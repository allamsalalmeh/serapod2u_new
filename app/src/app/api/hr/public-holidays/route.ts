import { hrCan } from '@/lib/server/hrAccess'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ─── Malaysian Public Holidays 2026–2030 ─────────────────────────
// Fixed dates are exact; Islamic/lunar dates are approximate & shift each year.
// `category` is template metadata only (hr_public_holidays has no category column). B2B: only 'national' rows are
// loaded automatically; state holidays (Thaipusam, Federal Territory Day, …) are added by HR with their `state`
// until state calendars exist (B6). HR reviews the loaded calendar before go-live (Gate 4.9).

const MALAYSIA_HOLIDAYS: Record<number, { name: string; date: string; is_recurring: boolean; category: string }[]> = {
    2026: [
        { name: "New Year's Day", date: '2026-01-01', is_recurring: true, category: 'national' },
        { name: 'Thaipusam', date: '2026-01-25', is_recurring: false, category: 'state' },
        { name: 'Federal Territory Day', date: '2026-02-01', is_recurring: true, category: 'state' },
        { name: 'Israk & Mikraj', date: '2026-02-17', is_recurring: false, category: 'national' },
        { name: 'Nuzul Al-Quran', date: '2026-03-20', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 1)', date: '2026-03-30', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 2)', date: '2026-03-31', is_recurring: false, category: 'national' },
        { name: 'Labour Day', date: '2026-05-01', is_recurring: true, category: 'national' },
        { name: 'Vesak Day', date: '2026-05-12', is_recurring: false, category: 'national' },
        { name: 'Agong Birthday', date: '2026-06-01', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 1)', date: '2026-06-07', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 2)', date: '2026-06-08', is_recurring: false, category: 'national' },
        { name: 'Awal Muharram', date: '2026-06-27', is_recurring: false, category: 'national' },
        { name: 'Merdeka Day', date: '2026-08-31', is_recurring: true, category: 'national' },
        { name: 'Mawlid Nabi', date: '2026-09-05', is_recurring: false, category: 'national' },
        { name: 'Malaysia Day', date: '2026-09-16', is_recurring: true, category: 'national' },
        { name: 'Deepavali', date: '2026-10-20', is_recurring: false, category: 'national' },
        { name: "Christmas Day", date: '2026-12-25', is_recurring: true, category: 'national' },
    ],
    2027: [
        { name: "New Year's Day", date: '2027-01-01', is_recurring: true, category: 'national' },
        { name: 'Thaipusam', date: '2027-01-14', is_recurring: false, category: 'state' },
        { name: 'Federal Territory Day', date: '2027-02-01', is_recurring: true, category: 'state' },
        { name: 'Israk & Mikraj', date: '2027-02-06', is_recurring: false, category: 'national' },
        { name: 'Nuzul Al-Quran', date: '2027-03-10', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 1)', date: '2027-03-20', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 2)', date: '2027-03-21', is_recurring: false, category: 'national' },
        { name: 'Labour Day', date: '2027-05-01', is_recurring: true, category: 'national' },
        { name: 'Vesak Day', date: '2027-05-01', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 1)', date: '2027-05-27', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 2)', date: '2027-05-28', is_recurring: false, category: 'national' },
        { name: 'Agong Birthday', date: '2027-06-07', is_recurring: false, category: 'national' },
        { name: 'Awal Muharram', date: '2027-06-17', is_recurring: false, category: 'national' },
        { name: 'Mawlid Nabi', date: '2027-08-26', is_recurring: false, category: 'national' },
        { name: 'Merdeka Day', date: '2027-08-31', is_recurring: true, category: 'national' },
        { name: 'Malaysia Day', date: '2027-09-16', is_recurring: true, category: 'national' },
        { name: 'Deepavali', date: '2027-11-08', is_recurring: false, category: 'national' },
        { name: "Christmas Day", date: '2027-12-25', is_recurring: true, category: 'national' },
    ],
    2028: [
        { name: "New Year's Day", date: '2028-01-01', is_recurring: true, category: 'national' },
        { name: 'Thaipusam', date: '2028-01-14', is_recurring: false, category: 'state' },
        { name: 'Federal Territory Day', date: '2028-02-01', is_recurring: true, category: 'state' },
        { name: 'Israk & Mikraj', date: '2028-01-27', is_recurring: false, category: 'national' },
        { name: 'Nuzul Al-Quran', date: '2028-02-28', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 1)', date: '2028-03-09', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 2)', date: '2028-03-10', is_recurring: false, category: 'national' },
        { name: 'Labour Day', date: '2028-05-01', is_recurring: true, category: 'national' },
        { name: 'Hari Raya Haji (Day 1)', date: '2028-05-16', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 2)', date: '2028-05-17', is_recurring: false, category: 'national' },
        { name: 'Vesak Day', date: '2028-05-20', is_recurring: false, category: 'national' },
        { name: 'Agong Birthday', date: '2028-06-05', is_recurring: false, category: 'national' },
        { name: 'Awal Muharram', date: '2028-06-06', is_recurring: false, category: 'national' },
        { name: 'Mawlid Nabi', date: '2028-08-15', is_recurring: false, category: 'national' },
        { name: 'Merdeka Day', date: '2028-08-31', is_recurring: true, category: 'national' },
        { name: 'Malaysia Day', date: '2028-09-16', is_recurring: true, category: 'national' },
        { name: 'Deepavali', date: '2028-10-28', is_recurring: false, category: 'national' },
        { name: "Christmas Day", date: '2028-12-25', is_recurring: true, category: 'national' },
    ],
    2029: [
        { name: "New Year's Day", date: '2029-01-01', is_recurring: true, category: 'national' },
        { name: 'Thaipusam', date: '2029-02-01', is_recurring: false, category: 'state' },
        { name: 'Federal Territory Day', date: '2029-02-01', is_recurring: true, category: 'state' },
        { name: 'Israk & Mikraj', date: '2029-01-16', is_recurring: false, category: 'national' },
        { name: 'Nuzul Al-Quran', date: '2029-02-17', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 1)', date: '2029-02-26', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 2)', date: '2029-02-27', is_recurring: false, category: 'national' },
        { name: 'Labour Day', date: '2029-05-01', is_recurring: true, category: 'national' },
        { name: 'Hari Raya Haji (Day 1)', date: '2029-05-06', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 2)', date: '2029-05-07', is_recurring: false, category: 'national' },
        { name: 'Vesak Day', date: '2029-05-10', is_recurring: false, category: 'national' },
        { name: 'Awal Muharram', date: '2029-05-26', is_recurring: false, category: 'national' },
        { name: 'Agong Birthday', date: '2029-06-04', is_recurring: false, category: 'national' },
        { name: 'Mawlid Nabi', date: '2029-08-04', is_recurring: false, category: 'national' },
        { name: 'Merdeka Day', date: '2029-08-31', is_recurring: true, category: 'national' },
        { name: 'Malaysia Day', date: '2029-09-16', is_recurring: true, category: 'national' },
        { name: 'Deepavali', date: '2029-11-15', is_recurring: false, category: 'national' },
        { name: "Christmas Day", date: '2029-12-25', is_recurring: true, category: 'national' },
    ],
    2030: [
        { name: "New Year's Day", date: '2030-01-01', is_recurring: true, category: 'national' },
        { name: 'Israk & Mikraj', date: '2030-01-05', is_recurring: false, category: 'national' },
        { name: 'Thaipusam', date: '2030-01-21', is_recurring: false, category: 'state' },
        { name: 'Federal Territory Day', date: '2030-02-01', is_recurring: true, category: 'state' },
        { name: 'Nuzul Al-Quran', date: '2030-02-07', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 1)', date: '2030-02-16', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Aidilfitri (Day 2)', date: '2030-02-17', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 1)', date: '2030-04-25', is_recurring: false, category: 'national' },
        { name: 'Hari Raya Haji (Day 2)', date: '2030-04-26', is_recurring: false, category: 'national' },
        { name: 'Labour Day', date: '2030-05-01', is_recurring: true, category: 'national' },
        { name: 'Awal Muharram', date: '2030-05-16', is_recurring: false, category: 'national' },
        { name: 'Vesak Day', date: '2030-05-29', is_recurring: false, category: 'national' },
        { name: 'Agong Birthday', date: '2030-06-03', is_recurring: false, category: 'national' },
        { name: 'Mawlid Nabi', date: '2030-07-25', is_recurring: false, category: 'national' },
        { name: 'Merdeka Day', date: '2030-08-31', is_recurring: true, category: 'national' },
        { name: 'Malaysia Day', date: '2030-09-16', is_recurring: true, category: 'national' },
        { name: 'Deepavali', date: '2030-11-05', is_recurring: false, category: 'national' },
        { name: "Christmas Day", date: '2030-12-25', is_recurring: true, category: 'national' },
    ],
}

async function getOrgContext(supabase: any) {
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return null
    const { data: userData } = await supabase
        .from('users')
        .select('organization_id, role_code')
        .eq('id', user.id)
        .single()
    if (!userData) return null
    let roleLevel = 99
    if (userData.role_code) {
        const { data: r } = await supabase.from('roles').select('role_level').eq('role_code', userData.role_code).maybeSingle()
        if (r) roleLevel = r.role_level
    }
    return { user, orgId: userData.organization_id, roleLevel }
}

// ─── GET: List holidays + available templates ─────────────────────

export async function GET(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctx = await getOrgContext(supabase)
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const year = url.searchParams.get('year')
        const templatesOnly = url.searchParams.get('templates') === '1'

        if (templatesOnly) {
            // Return available template years
            return NextResponse.json({
                success: true,
                available_years: Object.keys(MALAYSIA_HOLIDAYS).map(Number),
                templates: Object.fromEntries(
                    Object.entries(MALAYSIA_HOLIDAYS).map(([y, holidays]) => [y, holidays.map(h => ({ name: h.name, date: h.date, category: h.category }))])
                ),
            })
        }

        // Fetch org holidays
        let query = supabase
            .from('hr_public_holidays')
            .select('*')
            .eq('organization_id', ctx.orgId)
            .order('date', { ascending: true })

        if (year) {
            query = query.gte('date', `${year}-01-01`).lte('date', `${year}-12-31`)
        }

        const { data, error } = await query
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        return NextResponse.json({ success: true, data: data || [], count: data?.length || 0 })
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

// ─── POST: Create holiday or load template ────────────────────────

export async function POST(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctx = await getOrgContext(supabase)
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!(await hrCan({ userId: ctx.user.id, organizationId: ctx.orgId, roleCode: null, roleLevel: ctx.roleLevel },
            'hr.settings.manage', () => ctx.roleLevel <= 20))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

        const body = await request.json()

        // Load template for a specific year
        if (body.action === 'load_template') {
            const year = body.year as number
            const template = MALAYSIA_HOLIDAYS[year]
            if (!template) return NextResponse.json({ error: `No template for year ${year}` }, { status: 400 })

            // Delete existing holidays for that year first
            if (body.replace) {
                await supabase
                    .from('hr_public_holidays')
                    .delete()
                    .eq('organization_id', ctx.orgId)
                    .gte('date', `${year}-01-01`)
                    .lte('date', `${year}-12-31`)
            }

            const national = template.filter(h => h.category === 'national')
            const skippedState = template.filter(h => h.category !== 'national').map(h => h.name)
            const rows = national.map(h => ({
                organization_id: ctx.orgId,
                name: h.name,
                date: h.date,
                is_recurring: h.is_recurring,
            }))

            const { error } = await supabase.from('hr_public_holidays').insert(rows)
            if (error) return NextResponse.json({ error: error.message }, { status: 400 })
            return NextResponse.json({
                success: true,
                message: `${rows.length} national holidays loaded for ${year}` + (skippedState.length ? `; state holidays not loaded: ${skippedState.join(', ')}` : ''),
                count: rows.length,
                skippedState,
            })
        }

        // Create single holiday
        const { name, date, is_recurring, state } = body
        if (!name || !date) return NextResponse.json({ error: 'name and date required' }, { status: 400 })

        const { data, error } = await supabase
            .from('hr_public_holidays')
            .insert({
                organization_id: ctx.orgId,
                name,
                date,
                is_recurring: is_recurring || false,
                state: state || null,
            })
            .select()
            .single()

        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

// ─── PUT: Update holiday ──────────────────────────────────────────

export async function PUT(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctx = await getOrgContext(supabase)
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!(await hrCan({ userId: ctx.user.id, organizationId: ctx.orgId, roleCode: null, roleLevel: ctx.roleLevel },
            'hr.settings.manage', () => ctx.roleLevel <= 20))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

        const body = await request.json()
        const { id } = body
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
        // Only real hr_public_holidays columns may change (no category column).
        const updates: Record<string, unknown> = {}
        for (const key of ['name', 'date', 'is_recurring', 'state'] as const) if (body[key] !== undefined) updates[key] = body[key]

        const { data, error } = await supabase
            .from('hr_public_holidays')
            .update(updates)
            .eq('id', id)
            .eq('organization_id', ctx.orgId)
            .select()
            .single()

        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

// ─── DELETE: Remove holiday ───────────────────────────────────────

export async function DELETE(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctx = await getOrgContext(supabase)
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!(await hrCan({ userId: ctx.user.id, organizationId: ctx.orgId, roleCode: null, roleLevel: ctx.roleLevel },
            'hr.settings.manage', () => ctx.roleLevel <= 20))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

        const url = new URL(request.url)
        const id = url.searchParams.get('id')
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

        const { error } = await supabase
            .from('hr_public_holidays')
            .delete()
            .eq('id', id)
            .eq('organization_id', ctx.orgId)

        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ success: true })
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
