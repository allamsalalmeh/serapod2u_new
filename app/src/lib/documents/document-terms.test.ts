import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

const generation = read('lib/documents/pdf-generation.ts')
const generator = read('lib/pdf-generator.ts')
const templates = read('lib/pdf-templates.ts')

describe('server-generated documents carry the organization Terms & Conditions', () => {
  it('resolves them through the shared organizations/terms helper', () => {
    expect(generation).toContain("from '@/lib/organizations/terms'")
    expect(generation).toContain('resolveOrganizationTerms(orgSettingsData)')
  })

  it('reads them from the issuing organization, the same one that picks the template', () => {
    // settingOrgId is the buyer for buyer-issued docs and the seller for
    // seller-issued ones; the terms must ride on that same single query.
    const query = generation.slice(
      generation.indexOf('let organizationTerms'),
      generation.indexOf('Fetch buyer organization logo'),
    )
    expect(query).toContain(".eq('id', settingOrgId)")
    expect(query).toContain('resolveOrganizationTerms(orgSettingsData)')
    // No second organization lookup smuggled in for the terms.
    expect(query).not.toContain('buyer_org_id)')
  })

  it('threads them onto the data every generator receives', () => {
    expect(generation).toContain('organization_terms: organizationTerms')
  })

  it('leaves payment_terms completely alone', () => {
    // The deposit/balance schedule is a different concept and keeps its own
    // normalizer and label formatter untouched.
    expect(generator).toContain('normalizePaymentTerms')
    expect(generator).toContain('formatPaymentTermsLabel')
    expect(generation).not.toContain('payment_terms = organizationTerms')
    expect(generator).not.toContain('payment_terms = ')
  })
})

describe('every commercial document type renders the section', () => {
  const documentTypes = [
    'generateOrderPDF',
    'generatePurchaseOrderPDF',
    'generateSalesOrderPDF',
    'generateInvoicePDF',
    'generateReceiptPDF',
    'generatePaymentPDF',
    'generatePaymentRequestPDF',
  ]

  it.each(documentTypes)('%s draws the terms before the signature trail', (method) => {
    const body = generator.slice(
      generator.indexOf(`async ${method}(`),
      generator.indexOf('return this.doc.output', generator.indexOf(`async ${method}(`)),
    )
    expect(body).toContain('this.addTermsSection(orderData.organization_terms')
    expect(body.indexOf('addTermsSection')).toBeLessThan(body.indexOf('addSignaturesApprovalTrail'))
  })

  it('covers the detailed generator and the classic template alike', () => {
    expect(generator).toContain('private addTermsSection(')
    expect(templates).toContain('private addTermsSection(')
    expect(templates).toContain('organization_terms?: string | null')
  })

  it('places the classic template section between the totals and the footer', () => {
    const body = templates.slice(templates.indexOf('// 4. Footer / Totals'))
    expect(body.indexOf('addTermsSection')).toBeLessThan(body.indexOf('const footerY'))
  })
})

describe('the rendered section behaves', () => {
  for (const [name, source] of [['detailed generator', generator], ['classic template', templates]] as const) {
    describe(name, () => {
      const body = source.slice(
        source.indexOf('private addTermsSection('),
        source.indexOf('return y + 3', source.indexOf('private addTermsSection(')),
      )

      it('draws nothing at all when no terms are stored', () => {
        expect(body).toContain("if (!value.trim()) return yPosition")
      })

      it('adds no default or placeholder text', () => {
        expect(body).not.toMatch(/Payment to be made to|Terms apply|N\/A/)
      })

      it('preserves the author formatting through the shared wrapper', () => {
        expect(body).toContain('wrapTermsLines(value')
        expect(body).toContain('this.doc.getTextWidth(indent)')
      })

      it('paginates instead of overrunning the footer', () => {
        expect(body).toContain('this.doc.addPage()')
        expect(body).toContain('if (y > bottomLimit)')
      })

      it('skips drawing a blank line but still advances the cursor', () => {
        expect(body).toContain('if (line) this.doc.text(line, this.margin, y)')
        expect(body).toContain('y += lineHeight')
      })
    })
  }
})
