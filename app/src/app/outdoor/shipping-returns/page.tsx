import { OutdoorDocPage } from '@/components/outdoor/OutdoorDocPage'

export const metadata = { title: 'Shipping & Returns' }

export default function OutdoorShippingPage() {
  return (
    <OutdoorDocPage
      title="Shipping & Returns"
      intro="Delivery in Malaysia and what to do if you need to return something."
      sections={[
        {
          heading: 'Shipping coverage',
          body: [
            'We pack and deliver every order ourselves, within Malaysia. For some addresses we may hand the parcel to a courier instead, and you will get its tracking number.',
            'Checkout uses one flat delivery rate for every address in Malaysia. When an order qualifies, that rate is shown as free shipping.',
          ],
        },
        {
          heading: 'Processing time',
          body: [
            'Paid orders enter our fulfilment desk for packing. We aim to send them out within 1–3 business days after payment confirmation, unless a product note states otherwise.',
            'Public holidays and peak seasons may add delay.',
          ],
        },
        {
          heading: 'Tracking',
          body: [
            'Sign in and open Track Order to see where your order is: paid, on its way, delivered. If a courier carries it, its tracking number and updates appear there too.',
          ],
        },
        {
          heading: 'Failed delivery',
          body: [
            'If a courier cannot complete delivery due to an incorrect address, unreachable recipient, or refusal, re-delivery or return-to-sender rules of the courier apply. Extra fees may be charged in those cases.',
          ],
        },
        {
          heading: 'Returns',
          body: [
            'If an item arrives damaged, defective, or incorrect, report it within 7 days of delivery from My account → Orders → Report a problem, with photos.',
            'Unused items in original packaging may be eligible for return subject to product type and approval. Hygiene-sensitive or custom items may be excluded.',
            'Approved returns are handled under the Refund Policy.',
          ],
        },
      ]}
    />
  )
}
