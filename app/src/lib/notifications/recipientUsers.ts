/**
 * "Specific users" recipients: stored as user UUIDs, shown as people.
 * Pure helpers shared by the picker and its tests.
 */
export interface RecipientUser {
    id: string
    full_name?: string | null
    email?: string | null
    phone?: string | null
    is_active?: boolean | null
}

export type RecipientUserChip =
    | { id: string; state: 'loaded'; label: string; detail: string; inactive: boolean }
    | { id: string; state: 'loading'; label: string; detail: string }
    | { id: string; state: 'unavailable'; label: string; detail: string }

/** Search text reduced to characters that cannot change a PostgREST filter. */
export function recipientUserSearchTerm(value: string | null | undefined): string {
    return String(value || '').replace(/[^\p{L}\p{N} @._+-]/gu, '').trim().slice(0, 60)
}

export const recipientUserName = (user: RecipientUser) =>
    String(user.full_name || '').trim() || String(user.email || '').split('@')[0] || 'Unnamed user'

export const recipientUserDetail = (user: RecipientUser) =>
    [user.email, user.phone].map((value) => String(value || '').trim()).filter(Boolean).join(' · ') || 'No email or phone'

/**
 * One chip per saved ID, in saved order. A UUID is never shown as the label:
 * an ID not yet looked up reads "Loading…", and one the lookup did not return
 * (deleted, or not visible to you) reads "Unavailable user".
 */
export function recipientUserChips(
    ids: string[],
    known: ReadonlyMap<string, RecipientUser>,
    unavailable: ReadonlySet<string>,
): RecipientUserChip[] {
    return ids.map((id) => {
        const user = known.get(id)
        if (user) {
            const inactive = user.is_active === false
            return { id, state: 'loaded', label: recipientUserName(user), detail: `${recipientUserDetail(user)}${inactive ? ' · inactive, receives nothing' : ''}`, inactive }
        }
        if (unavailable.has(id)) {
            return { id, state: 'unavailable', label: 'Unavailable user', detail: 'Deleted, or not visible to you. Receives nothing — remove it or ask an administrator.' }
        }
        return { id, state: 'loading', label: 'Loading…', detail: 'Looking up this user' }
    })
}

/** Saved IDs that still need a lookup. */
export function idsToHydrate(ids: string[], known: ReadonlyMap<string, RecipientUser>, unavailable: ReadonlySet<string>): string[] {
    return ids.filter((id) => !known.has(id) && !unavailable.has(id))
}

/** Fetch names for saved IDs; failures leave them unresolved rather than inventing names. */
export async function fetchRecipientUsers(
    ids: string[],
    fetcher: (url: string) => Promise<{ ok: boolean; json: () => Promise<any> }> = (url) => fetch(url),
): Promise<{ users: RecipientUser[]; unavailable: string[]; error?: string }> {
    if (ids.length === 0) return { users: [], unavailable: [] }
    const params = new URLSearchParams()
    ids.forEach((id) => params.append('ids', id))
    try {
        const response = await fetcher(`/api/notifications/recipient-users?${params}`)
        const data = await response.json()
        if (!response.ok) return { users: [], unavailable: [], error: data?.error || 'Could not load user names' }
        return { users: Array.isArray(data.users) ? data.users : [], unavailable: Array.isArray(data.unavailable) ? data.unavailable : [] }
    } catch (error: any) {
        return { users: [], unavailable: [], error: error?.message || 'Could not load user names' }
    }
}
