import { OutdoorDocPage } from '@/components/outdoor/OutdoorDocPage'

export const metadata = { title: 'Refund Policy' }

export default function OutdoorRefundPage() {
  return (
    <OutdoorDocPage
      title="Refund Policy"
      intro="When and how we refund Outdoor orders."
      sections={[
        {
          heading: 'When refunds apply',
          body: [
            'Payment failed or cancelled before fulfilment — no charge should remain; contact us if your bank statement differs.',
            'Item not received after an unreasonable delay caused by our fulfilment error.',
            'Damaged, defective, or wrong item confirmed by our team after you report it with evidence.',
            'Approved returns under Shipping & Returns.',
          ],
        },
        {
          heading: 'How to request a refund',
          body: [
            'Sign in, open My account → Orders, and choose Report a problem on the order. Tell us what happened and we reply by email.',
            'For damaged or wrong items, add clear photos of the product and packaging.',
            'You can follow the status of your request on the same order. If you cannot sign in, use the Contact page with your order reference and checkout email.',
          ],
        },
        {
          heading: 'Method & timing',
          body: [
            'Approved refunds are returned to the original payment method where possible: card payments through Stripe, FPX and e-wallet payments through Billplz or ToyyibPay.',
            'After we approve a refund, bank or e-wallet posting typically takes 5–14 business days depending on the provider.',
          ],
        },
        {
          heading: 'Non-refundable cases',
          body: [
            'Change of mind after the parcel has been shipped may be declined or limited to store credit, unless required by law.',
            'Items returned used, incomplete, or without original packaging may be refused.',
            'Shipping fees are refundable only when the return is due to our error.',
          ],
        },
      ]}
    />
  )
}
