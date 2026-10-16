import {
    INVALID_REFERENCE_WARNING_MESSAGE,
    INVALID_SHOP_WARNING_MESSAGE,
} from '@/lib/engagement/profile-link-validation'

export interface IncompleteProfileMessageInput {
    name?: string | null
    missingShop: boolean
    missingReference: boolean
    invalidShop?: boolean
    invalidReference?: boolean
}

export interface CollectProfileCompletionInput {
    name?: string | null
    claimLane?: 'shop' | 'consumer' | null
    requestedClaimLane?: 'shop' | null
    organizationId?: string | null
    organizationTypeCode?: string | null
    shopName?: string | null
    referralPhone?: string | null
    isShopLinkValid?: boolean | null
    isReferenceLinkValid?: boolean | null
}

export interface CollectProfileCompletionResult {
    shouldBlockCollect: boolean
    modalTitle: string
    modalMessage: string
    missingShop: boolean
    missingReference: boolean
    invalidShop: boolean
    invalidReference: boolean
    missingFields: string[]
}

function hasValue(value?: string | null): boolean {
    return Boolean(value?.trim())
}

export function hasValidLinkedShop(input: Pick<CollectProfileCompletionInput, 'organizationId' | 'organizationTypeCode' | 'shopName' | 'isShopLinkValid'>): boolean {
    if (typeof input.isShopLinkValid === 'boolean') {
        return input.isShopLinkValid
    }

    if (!hasValue(input.organizationId)) {
        return false
    }

    const orgTypeCode = input.organizationTypeCode?.trim().toUpperCase()
    return !orgTypeCode || orgTypeCode === 'SHOP'
}

export function hasValidReferenceLink(input: Pick<CollectProfileCompletionInput, 'referralPhone' | 'isReferenceLinkValid'>): boolean {
    if (typeof input.isReferenceLinkValid === 'boolean') {
        return input.isReferenceLinkValid
    }

    return hasValue(input.referralPhone)
}

function hasShopProfileValue(input: Pick<CollectProfileCompletionInput, 'organizationId' | 'shopName'>): boolean {
    return hasValue(input.organizationId)
}

export function getIncompleteProfileMessage(input: IncompleteProfileMessageInput): string {
    const resolvedName = input.name?.trim() || 'there'
    const shopIssue = input.missingShop || input.invalidShop
    const referenceIssue = input.missingReference || input.invalidReference

    if (shopIssue && referenceIssue) {
        return `Hi ${resolvedName}, your **shop** and **reference** are not valid. Please update your profile before collecting points.`
    }

    if (shopIssue) {
        return `Hi ${resolvedName}, your **shop** is not valid. Please update your profile before collecting points.`
    }

    if (referenceIssue) {
        return `Hi ${resolvedName}, your **reference** is not valid. Please update your profile before collecting points.`
    }

    return ''
}

export function resolveCollectProfileCompletion(input: CollectProfileCompletionInput): CollectProfileCompletionResult {
    // Consumer lane users do not need shop/reference to collect points
    if (input.claimLane === 'consumer') {
        return {
            shouldBlockCollect: false,
            modalTitle: '',
            modalMessage: '',
            missingShop: false,
            missingReference: false,
            invalidShop: false,
            invalidReference: false,
            missingFields: [],
        }
    }

    const hasShopValue = hasShopProfileValue(input)
    const hasReferenceValue = hasValue(input.referralPhone)
    const validShopLink = hasValidLinkedShop(input)
    const validReferenceLink = hasValidReferenceLink(input)

    const missingShop = !hasShopValue
    const invalidShop = hasShopValue && !validShopLink
    const missingReference = !hasReferenceValue
    const invalidReference = hasReferenceValue && !validReferenceLink
    const shouldBlockCollect = missingShop || missingReference || invalidShop || invalidReference
    const missingFields: string[] = []

    if (missingShop || invalidShop) {
        missingFields.push('Shop')
    }

    if (missingReference || invalidReference) {
        missingFields.push('Reference')
    }

    return {
        shouldBlockCollect,
        modalTitle: 'Complete Your Profile',
        modalMessage: shouldBlockCollect
            ? getIncompleteProfileMessage({
                name: input.name,
                missingShop,
                missingReference,
                invalidShop,
                invalidReference,
            })
            : '',
        missingShop,
        missingReference,
        invalidShop,
        invalidReference,
        missingFields,
    }
}
