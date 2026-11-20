// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import PwaBootstrap from './PwaBootstrap'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PwaBootstrap', () => {
  it('server-renders the inline bootstrap script', () => {
    const html = renderToString(<PwaBootstrap />)

    expect(html).toContain('id="pwa-bootstrap"')
    expect(html).toContain('beforeinstallprompt')
    expect(html).toContain("navigator.serviceWorker.register('/sw.js',{scope:'/'})")
  })

  it('hydrates the server script and then drops it from the React tree', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(<PwaBootstrap />)
    document.body.appendChild(container)
    expect(container.querySelector('#pwa-bootstrap')).not.toBeNull()

    await act(async () => {
      hydrateRoot(container, <PwaBootstrap />)
    })

    expect(container.querySelector('#pwa-bootstrap')).toBeNull()
  })

  it('never creates a script element during a client-only render', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    await act(async () => {
      createRoot(container).render(<PwaBootstrap />)
    })

    expect(container.querySelector('script')).toBeNull()
  })
})
