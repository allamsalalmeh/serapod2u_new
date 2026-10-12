import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadProcessableBatch } from '@/lib/qr-batch-access-server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user: saUser } } = await supabase.auth.getUser()
  if (!saUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const saDenied = await guardUserOperation(saUser.id, 'manufacturing.production.manage')
  if (saDenied) return saDenied
  const { batch_id } = await request.json()

  if (!batch_id) {
    return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 })
  }

  const loaded = await loadProcessableBatch(supabase, saUser.id, batch_id, 'id, packing_status')
  if (loaded.response) return loaded.response
  const { admin, batch } = loaded

  if (batch.packing_status === 'completed') {
    return NextResponse.json({ message: 'Already packed' })
  }

  if (batch.packing_status === 'queued' || batch.packing_status === 'processing') {
    return NextResponse.json({ message: 'Packing already in progress' })
  }

  // Set to queued
  const { data: queued, error: updateError } = await admin
    .from('qr_batches')
    .update({ packing_status: 'queued' })
    .eq('id', batch_id)
    .select('id')

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }
  if (!queued || queued.length === 0) {
    return NextResponse.json({ error: 'Packing could not be queued for this batch' }, { status: 409 })
  }

  return NextResponse.json({ success: true, status: 'queued' })
}
