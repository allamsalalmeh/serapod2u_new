'use client'
import { useState } from 'react'

export default function LegacyCutoverPreview() {
  const [role, setRole] = useState('legacy-user')
  const [preview, setPreview] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function load(page = 0) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/security-access/governance/legacy-preview?${new URLSearchParams({ role, page: String(page) })}`, { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) { setPreview(null); setError(body.error || 'Preview unavailable'); return }
      setPreview(body)
    } catch { setError('Preview unavailable'); setPreview(null) }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-lg border p-4 text-sm" aria-label="Legacy cutover preview">
    <h3 className="font-semibold">Legacy cutover preview · Root Administrators</h3>
    <p className="text-gray-500">Owner-controlled review only. Active compatibility policies continue granting access.</p>
    <div className="flex flex-wrap gap-2">
      <select aria-label="Legacy policy" disabled={busy} value={role} onChange={e => { setRole(e.target.value); setPreview(null) }} className="rounded border p-2">
        {['user', 'sa', 'hq', 'power-user', 'manager', 'shop'].map(k => <option key={k} value={`legacy-${k}`}>Legacy {k.toUpperCase()}</option>)}
      </select>
      <button disabled={busy} type="button" onClick={() => void load()} className="rounded border px-3 py-2">{busy ? 'Loading…' : 'Load read-only preview'}</button>
    </div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {preview && <>
      <p>{preview.warning}</p>
      {!preview.scopeCoverageVerified && <p role="alert" className="text-amber-800">Owner-run scope correction SQL is pending. This installed preview can overstate replacement coverage; do not approve cutover from these results.</p>}
      <p>{preview.overview?.find((r: any) => r.role_key === role)?.active_users ?? '—'} current holders · {preview.total ?? '—'} permission rows · {preview.rows.filter((r: any) => r.would_lose).length} potential losses on this page</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['User / organization', 'Permission', 'Replacement coverage', 'Review'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead>
        <tbody>{preview.rows.map((r: any, i: number) => <tr key={`${r.assignment_id}:${r.permission_key}:${i}`} className="border-t"><td className="p-2">{r.email}<br />{r.organization_id}</td><td className="p-2">{r.permission_key}{r.sensitive && <strong> · sensitive</strong>}</td><td className="p-2">{r.root_access ? 'Root Access (separate)' : r.covered_by.join(', ') || 'No proven replacement'}</td><td className="p-2">{r.would_lose ? 'Potential access loss' : 'Review coverage'}</td></tr>)}</tbody></table></div>
      <div className="flex flex-wrap items-center gap-2"><button disabled={busy || preview.page === 0} onClick={() => void load(preview.page - 1)} className="rounded border p-2">Previous</button><span>Page {preview.page + 1}</span><button disabled={busy || preview.rows.length < 100 || (preview.total != null && (preview.page + 1) * 100 >= preview.total)} onClick={() => void load(preview.page + 1)} className="rounded border p-2">Next</button>
        <button type="button" className="rounded border p-2" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(preview, null, 2)], { type: 'application/json' }))
          const a = document.createElement('a'); a.href = url; a.download = `${role}-review-page-${preview.page + 1}.json`; a.click(); URL.revokeObjectURL(url)
        }}>Export this review page</button></div>
    </>}
  </section>
}
