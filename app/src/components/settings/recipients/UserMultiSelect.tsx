
import { useState, useEffect, useRef } from 'react'
import { Search, X, User as UserIcon, Loader2, AlertTriangle } from 'lucide-react'
import { Input } from "../../ui/input"
import { Badge } from "../../ui/badge"
import { useDebounce } from "../../../hooks/use-debounce"
import {
    fetchRecipientUsers,
    idsToHydrate,
    recipientUserChips,
    recipientUserDetail,
    recipientUserName,
    type RecipientUser,
} from '@/lib/notifications/recipientUsers'

interface User {
    id: string
    full_name: string
    email?: string
    phone?: string
}

interface UserMultiSelectProps {
    /** Saved selection — stored as user UUIDs. */
    selectedUserIds: string[]
    onSelectionChange: (ids: string[]) => void
    onUsersLoaded?: (users: User[]) => void
}

/**
 * Picker for "Specific users". IDs stay the stored value; every saved ID is
 * looked up by ID whenever the selection changes (including when the drawer is
 * reopened), so chips show names with email/phone instead of UUIDs. An ID the
 * lookup does not return is shown as "Unavailable user", never as a UUID.
 * Lookups use /api/notifications/recipient-users (platform.settings.manage,
 * caller's own row-level security) — not the user-management API.
 */
export function UserMultiSelect({ selectedUserIds, onSelectionChange, onUsersLoaded }: UserMultiSelectProps) {
    const [query, setQuery] = useState('')
    const debouncedQuery = useDebounce(query, 300)
    const [results, setResults] = useState<RecipientUser[]>([])
    const [loading, setLoading] = useState(false)
    const [known, setKnown] = useState<Map<string, RecipientUser>>(() => new Map())
    const [unavailable, setUnavailable] = useState<Set<string>>(() => new Set())
    const [lookupError, setLookupError] = useState<string | null>(null)
    const [open, setOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const selectionKey = selectedUserIds.join(',')

    // Hydrate every saved ID that has not been looked up yet.
    useEffect(() => {
        const missing = idsToHydrate(selectedUserIds, known, unavailable)
        if (missing.length === 0) return
        let cancelled = false
        void fetchRecipientUsers(missing).then(({ users, unavailable: notFound, error }) => {
            if (cancelled) return
            setLookupError(error || null)
            if (error) return
            setKnown((current) => {
                const next = new Map(current)
                users.forEach((user) => next.set(user.id, user))
                return next
            })
            // Anything asked for and not returned is unavailable (deleted or not visible).
            const returned = new Set(users.map((user) => user.id))
            setUnavailable((current) => new Set([...current, ...notFound, ...missing.filter((id) => !returned.has(id))]))
        })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectionKey])

    // Tell the drawer who is selected, in saved order, once names are known.
    useEffect(() => {
        onUsersLoaded?.(selectedUserIds.flatMap((id) => {
            const user = known.get(id)
            return user ? [{ id: user.id, full_name: recipientUserName(user), email: user.email || undefined, phone: user.phone || undefined }] : []
        }))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectionKey, known])

    useEffect(() => {
        const searchUsers = async () => {
            if (!debouncedQuery || debouncedQuery.trim().length < 2) {
                setResults([])
                return
            }

            setLoading(true)
            try {
                const res = await fetch(`/api/notifications/recipient-users?q=${encodeURIComponent(debouncedQuery)}`)
                const data = await res.json()
                if (res.ok && Array.isArray(data.users)) {
                    setResults(data.users)
                    setOpen(true)
                } else {
                    setResults([])
                }
            } catch (error) {
                console.error(error)
            } finally {
                setLoading(false)
            }
        }

        searchUsers()
    }, [debouncedQuery])

    const handleSelect = (user: RecipientUser) => {
        setKnown((current) => new Map(current).set(user.id, user))
        if (!selectedUserIds.includes(user.id)) onSelectionChange([...selectedUserIds, user.id])
        setQuery('')
        setOpen(false)
    }

    const handleRemove = (userId: string) => {
        onSelectionChange(selectedUserIds.filter(id => id !== userId))
    }

    const chips = recipientUserChips(selectedUserIds, known, unavailable)

    return (
        <div className="space-y-3" ref={containerRef}>
            <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                <Input
                    placeholder="Search by Full Name, Email, Phone..."
                    aria-label="Search users"
                    className="pl-9"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value)
                        if (!open) setOpen(true)
                    }}
                    onFocus={() => {
                        if (results.length > 0) setOpen(true)
                    }}
                />
                {loading && (
                    <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-gray-500" />
                )}

                {open && results.length > 0 && (
                    <div className="absolute top-full mt-1 w-full bg-white border rounded-md shadow-lg z-50 max-h-[200px] overflow-auto">
                        {results.map(user => (
                            <div
                                key={user.id}
                                className="p-2 hover:bg-gray-50 cursor-pointer flex justify-between items-center"
                                onClick={() => handleSelect(user)}
                            >
                                <div className="overflow-hidden">
                                    <div className="font-medium text-sm truncate">{recipientUserName(user)}</div>
                                    <div className="text-xs text-gray-500 truncate">{recipientUserDetail(user)}</div>
                                </div>
                                {selectedUserIds.includes(user.id) && <Badge variant="secondary" className="text-[10px] ml-2 shrink-0">Selected</Badge>}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {lookupError && (
                <p role="alert" className="text-xs text-amber-700">Could not load user names ({lookupError}). Your selection is kept.</p>
            )}

            <ul className="flex flex-wrap gap-2" aria-label="Selected users">
                {chips.map((chip) => (
                    <li key={chip.id} title={chip.detail}>
                        <Badge
                            variant="secondary"
                            className={`pl-2 pr-1 py-1 flex items-center gap-1 ${chip.state === 'unavailable' || (chip.state === 'loaded' && chip.inactive) ? 'border border-amber-200 bg-amber-50 text-amber-800' : ''}`}
                        >
                            {chip.state === 'loading'
                                ? <Loader2 className="w-3 h-3 animate-spin text-gray-500" aria-hidden />
                                : chip.state === 'unavailable'
                                    ? <AlertTriangle className="w-3 h-3" aria-hidden />
                                    : <UserIcon className="w-3 h-3 text-gray-500" aria-hidden />}
                            <span>{chip.label}</span>
                            {chip.state !== 'loading' && <span className="text-xs text-muted-foreground">({chip.detail})</span>}
                            <button
                                type="button"
                                aria-label={`Remove ${chip.label}`}
                                onClick={() => handleRemove(chip.id)}
                                className="ml-1 hover:bg-gray-200 rounded-full p-0.5"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </Badge>
                    </li>
                ))}
            </ul>
        </div>
    )
}
