'use client'

import ModuleLightHeader from '@/components/layout/ModuleLightHeader'

interface CustomerGrowthHeroBannerProps {
    userName: string | null
    bannerImageUrl?: string | null
    /** What the person can actually do here (see describeCustomerGrowthFunctions). */
    description?: string
}

export default function CustomerGrowthHeroBanner({ userName, description = 'Customer & Growth functions available to you.' }: CustomerGrowthHeroBannerProps) {
    const firstName = userName?.trim().split(/\s+/)[0]

    return (
        <ModuleLightHeader
            eyebrow="Customer & Growth"
            title={firstName ? `Welcome, ${firstName}` : 'Growth hub'}
            description={description}
        />
    )
}
