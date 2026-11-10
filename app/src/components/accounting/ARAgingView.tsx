'use client'

import SubledgerAgingView from './SubledgerAgingView'

interface ARAgingViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

/** Accounts receivable aging from posted invoices and the money actually received. */
export default function ARAgingView(_props: ARAgingViewProps) {
  return <SubledgerAgingView side="AR" />
}
