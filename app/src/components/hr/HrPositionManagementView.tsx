'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Briefcase, Loader2, Plus, RefreshCw, Search, Send, Users } from 'lucide-react'
import HrCreatePositionView from '@/components/hr/HrCreatePositionView'

interface HrPositionManagementViewProps {
  organizationId: string
  canEdit: boolean
}

interface PositionSlot {
  id: string
  position_code: string
  name: string
  job_classification_id: string | null
  org_tier: string
  lifecycle_status: string
  incumbent_user_id?: string | null
  incumbent_name?: string | null
  occupancy?: 'FILLED' | 'VACANT'
  job_classification?: { code: string; name: string } | null
}

interface JobClassification { id: string; code: string; name: string }

interface ChangeRequest {
  id: string
  request_type: string
  status: string
  effective_date: string | null
  change_payload: Record<string, unknown>
}

const json = async <T,>(res: Response) => res.json() as Promise<{ success: boolean; data?: T; error?: string }>

const STATUS_BADGE: Record<string, { className: string; label: string }> = {
  active: { className: 'bg-green-100 text-green-700', label: 'Active' },
  inactive: { className: 'bg-gray-100 text-gray-600', label: 'Inactive' },
  frozen: { className: 'bg-amber-100 text-amber-700', label: 'Frozen' },
  closed: { className: 'bg-red-100 text-red-700', label: 'Closed' },
}

const REQUEST_STATUS_BADGE: Record<string, { className: string; label: string }> = {
  draft: { className: 'bg-gray-100 text-gray-600', label: 'Draft' },
  pending: { className: 'bg-blue-100 text-blue-700', label: 'Pending Approval' },
  returned: { className: 'bg-amber-100 text-amber-700', label: 'Returned' },
  rejected: { className: 'bg-red-100 text-red-700', label: 'Rejected' },
  approved: { className: 'bg-green-100 text-green-700', label: 'Approved' },
  scheduled: { className: 'bg-violet-100 text-violet-700', label: 'Scheduled' },
  effective: { className: 'bg-emerald-100 text-emerald-700', label: 'Effective' },
  activation_failed: { className: 'bg-red-100 text-red-700', label: 'Activation Failed' },
  cancelled: { className: 'bg-gray-100 text-gray-600', label: 'Cancelled' },
}

export default function HrPositionManagementView({ organizationId, canEdit }: HrPositionManagementViewProps) {
  const { toast } = useToast()
  const [slots, setSlots] = useState<PositionSlot[]>([])
  const [classifications, setClassifications] = useState<JobClassification[]>([])
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [occupancyFilter, setOccupancyFilter] = useState('all')
  const [lifecycleFilter, setLifecycleFilter] = useState('all')
  const [mode, setMode] = useState<'list' | 'create'>('list')
  const [tab, setTab] = useState('positions')
  const [submittingId, setSubmittingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (occupancyFilter !== 'all') params.set('occupancy', occupancyFilter)
      if (lifecycleFilter !== 'all') params.set('lifecycle', lifecycleFilter)
      const [slotsRes, jcRes, reqRes] = await Promise.all([
        fetch(`/api/hr/position-slots?${params.toString()}`).then(json<PositionSlot[]>),
        fetch('/api/hr/job-classifications').then(json<JobClassification[]>),
        fetch('/api/hr/position-change-requests').then(json<ChangeRequest[]>),
      ])
      if (slotsRes.success) setSlots(slotsRes.data ?? [])
      if (jcRes.success) setClassifications(jcRes.data ?? [])
      if (reqRes.success) setRequests(reqRes.data ?? [])
    } finally {
      setLoading(false)
    }
  }, [search, occupancyFilter, lifecycleFilter])

  useEffect(() => { void load() }, [load])

  const sorted = useMemo(() => [...slots].sort((a, b) => a.position_code.localeCompare(b.position_code)), [slots])

  const submitRequest = async (id: string) => {
    setSubmittingId(id)
    try {
      const res = await fetch(`/api/hr/position-change-requests/${id}/submit`, { method: 'POST' }).then(json)
      if (!res.success) { toast({ title: 'Could not submit request', description: res.error, variant: 'destructive' }); return }
      toast({ title: 'Submitted for approval' })
      void load()
    } finally {
      setSubmittingId(null)
    }
  }

  const closeCreate = (nextTab = 'positions') => {
    setMode('list')
    setTab(nextTab)
    void load()
  }

  if (mode === 'create') {
    return (
      <HrCreatePositionView
        organizationId={organizationId}
        onCancel={() => setMode('list')}
        onDone={() => closeCreate('positions')}
        onViewRequests={() => closeCreate('requests')}
      />
    )
  }

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="positions">Positions</TabsTrigger>
          <TabsTrigger value="requests">Change Requests</TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Briefcase className="h-5 w-5 text-blue-600" /> Position Management
                  </CardTitle>
                  <CardDescription>Position-centric slots, occupancy and lifecycle status</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
                  </Button>
                  {canEdit && (
                    <Button size="sm" onClick={() => setMode('create')}>
                      <Plus className="h-4 w-4 mr-2" /> Add Position
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative w-full sm:w-[260px]">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or name..." className="pl-8" />
                </div>
                <Select value={occupancyFilter} onValueChange={setOccupancyFilter}>
                  <SelectTrigger className="w-full sm:w-[160px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All occupancy</SelectItem>
                    <SelectItem value="FILLED">Filled</SelectItem>
                    <SelectItem value="VACANT">Vacant</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={lifecycleFilter} onValueChange={setLifecycleFilter}>
                  <SelectTrigger className="w-full sm:w-[160px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="frozen">Frozen</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {loading ? (
                <div className="py-8 text-center text-gray-500">Loading positions...</div>
              ) : sorted.length === 0 ? (
                <div className="py-8 text-center text-gray-500">No positions found.</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-gray-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">Code</th>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Job Classification</th>
                        <th className="px-3 py-2 font-medium">Tier</th>
                        <th className="px-3 py-2 font-medium">Incumbent</th>
                        <th className="px-3 py-2 font-medium">Occupancy</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {sorted.map((s) => (
                        <tr key={s.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono text-xs">{s.position_code}</td>
                          <td className="px-3 py-2">{s.name}</td>
                          <td className="px-3 py-2">{s.job_classification?.name ?? '—'}</td>
                          <td className="px-3 py-2">{s.org_tier ?? '—'}</td>
                          <td className="px-3 py-2">{s.incumbent_name ?? '—'}</td>
                          <td className="px-3 py-2">
                            <Badge variant={s.occupancy === 'FILLED' ? 'default' : 'secondary'}>
                              {s.occupancy === 'FILLED' ? 'Filled' : 'Vacant'}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            <Badge className={STATUS_BADGE[s.lifecycle_status]?.className ?? ''}>
                              {STATUS_BADGE[s.lifecycle_status]?.label ?? s.lifecycle_status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>


        <TabsContent value="requests">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-blue-600" /> Position Change Requests
              </CardTitle>
              <CardDescription>Approval-governed structural changes</CardDescription>
            </CardHeader>
            <CardContent>
              {requests.length === 0 ? (
                <div className="py-8 text-center text-gray-500">No change requests yet.</div>
              ) : (
                <div className="space-y-2">
                  {requests.map((r) => {
                    const badge = REQUEST_STATUS_BADGE[r.status] ?? { className: '', label: r.status }
                    const canSubmit = canEdit && (r.status === 'draft' || r.status === 'returned')
                    return (
                      <div key={r.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="font-medium">
                            {r.request_type.replace(/_/g, ' ')}
                            {r.change_payload?.name ? <span className="font-normal text-gray-600"> · {String(r.change_payload.name)}</span> : null}
                          </div>
                          <div className="text-xs text-gray-500">
                            {r.change_payload?.position_code ? `Code: ${String(r.change_payload.position_code)}` : ''}
                            {r.effective_date ? ` · Effective ${r.effective_date}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className={badge.className}>{badge.label}</Badge>
                          {canSubmit && (
                            <Button size="sm" variant="outline" onClick={() => void submitRequest(r.id)} disabled={submittingId === r.id}>
                              {submittingId === r.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                              Submit
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    </div>
  )
}
