import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// get_journey_qr_count(p_journey_config_id uuid) is the only signature on
// staging; PostgREST rejects calls whose argument names do not match it.
const forms = ['ScratchCardCampaignForm.tsx', 'SpinWheelCampaignForm.tsx']

const rpcArgNames = (source: string, fn: string): string[][] =>
  [...source.matchAll(new RegExp(`rpc\\('${fn}',\\s*\\{([^}]*)\\}`, 'g'))].map(match =>
    match[1].split(',').map(part => part.split(':')[0].trim()).filter(Boolean),
  )

describe('campaign forms call get_journey_qr_count with its real argument', () => {
  it.each(forms)('%s passes p_journey_config_id only', (file) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    const calls = rpcArgNames(source, 'get_journey_qr_count')
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toEqual(['p_journey_config_id'])
  })
})
