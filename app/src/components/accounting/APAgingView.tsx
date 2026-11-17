'use client'

import SubledgerAgingView from './SubledgerAgingView'

interface APAgingViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

/** Accounts payable aging from posted invoices and the money actually paid. */
export default function APAgingView({ userProfile }: APAgingViewProps) {
  return <SubledgerAgingView side="AP" userProfile={userProfile} />
}
