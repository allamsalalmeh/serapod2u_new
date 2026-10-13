// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import DataScopePanel from './DataScopePanel'

afterEach(() => cleanup())

const scopes = [
  { id: 's1', scope_type: 'organization', display_name: 'Serapod HQ' },
  { id: 's2', scope_type: 'warehouse', display_name: 'Main WH' },
]
const organizations = [{ id: 'o1', org_name: 'Serapod HQ' }]

describe('Data Scope (Advanced)', () => {
  it('groups scopes by type and keeps the empty-scope warning in the accessible ⓘ explanation', async () => {
    render(<DataScopePanel scopes={scopes} organizations={organizations} />)
    expect(screen.queryByText('Main WH')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^warehouse scopes, 1/ }))
    expect(screen.getByText('Main WH')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'About Data Scope' }))
    expect(screen.getByText(/An empty scope does not mean global access/)).toBeTruthy()
  })

  it('searches across labels and types, and shows an accurate empty state', async () => {
    render(<DataScopePanel scopes={scopes} organizations={organizations} />)
    await userEvent.type(screen.getByLabelText('Search scopes'), 'main')
    expect(screen.getByText('Main WH')).toBeTruthy()
    expect(screen.queryByText('Serapod HQ')).toBeNull()
    await userEvent.clear(screen.getByLabelText('Search scopes'))
    await userEvent.type(screen.getByLabelText('Search scopes'), 'nothing')
    expect(screen.getByText('No scopes match “nothing”.')).toBeTruthy()
  })

  it('is a reference catalogue only: an empty catalogue never implies global access', () => {
    render(<DataScopePanel scopes={[]} organizations={[]} />)
    expect(screen.getByRole('heading', { name: 'Data Scope Definitions' })).toBeTruthy()
    expect(screen.getByText('No scopes defined.')).toBeTruthy()
  })
})
