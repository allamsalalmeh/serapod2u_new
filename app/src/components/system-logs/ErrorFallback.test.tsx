// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const report = vi.fn((..._args: unknown[]) => 'ERR-ABCDEFGHJKMN')
vi.mock('@/lib/system-logs/client', () => ({ reportClientError: (...args: unknown[]) => report(...args) }))

import ErrorFallback from './ErrorFallback'

afterEach(() => { cleanup(); report.mockClear() })

describe('render error boundary', () => {
  it('reports the failure once with its digest and shows the reference to quote', async () => {
    const reset = vi.fn()
    const error = Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '2468013579' })
    render(<ErrorFallback error={error} reset={reset} scope="page" />)
    expect(await screen.findByText('ERR-ABCDEFGHJKMN')).toBeTruthy()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(error, expect.objectContaining({ action: 'Page render (error boundary)', reportWarnings: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalled()
  })

  it('still renders a usable fallback when nothing could be reported', () => {
    report.mockReturnValueOnce(null as any)
    render(<ErrorFallback error={new Error('x')} scope="application" />)
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    expect(screen.queryByText(/Reference:/)).toBeNull()
  })
})
