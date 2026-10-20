export const metadata = { title: 'FAQ' }

const FAQS = [
  {
    q: 'How do I place an order?',
    a: 'Browse the Shop, add items to your cart, then complete Checkout with your delivery details. Shipping is a single flat rate, or free when the order qualifies. You will be redirected to our secure payment gateway.',
  },
  {
    q: 'When is my order marked as paid?',
    a: 'Only after the payment provider sends a verified webhook to our system. Seeing a success page means the order was created; final paid status depends on that confirmation.',
  },
  {
    q: 'How can I track my parcel?',
    a: 'Sign in and open Track Order, or My account → Orders. You will see when it is paid, on its way and delivered; if a courier carries it, the tracking number appears there too. We also email you when it ships.',
  },
  {
    q: 'Do you ship outside Malaysia?',
    a: 'We currently deliver within Malaysia only. International options may be enabled later if courier coverage and rates support them.',
  },
  {
    q: 'Can I change or cancel an order?',
    a: 'Contact us as soon as possible with your order reference. If the order is already packed or handed to the courier, changes may not be possible.',
  },
  {
    q: 'How do refunds work?',
    a: 'Open My account → Orders and choose Report a problem on the order. See our Refund Policy for details. Approved refunds go back through the original payment method where possible.',
  },
  {
    q: 'Where is my customer account?',
    a: 'Use Account in the header to manage profile details and view Outdoor order history for the email on your login.',
  },
]

export default function OutdoorFaqPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 sm:px-8 py-16 sm:py-20">
      <h1 className="font-display text-4xl sm:text-5xl tracking-tight">FAQ</h1>
      <p className="mt-4 text-[var(--out-muted)] leading-relaxed">
        Common questions. Still stuck? Contact us.
      </p>
      <ul className="mt-10 space-y-6">
        {FAQS.map((item) => (
          <li key={item.q} className="border-t border-[var(--out-line)] pt-6">
            <h2 className="font-display text-xl text-[var(--out-ink)]">{item.q}</h2>
            <p className="mt-2 text-sm sm:text-[15px] text-[var(--out-muted)] leading-relaxed">{item.a}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
