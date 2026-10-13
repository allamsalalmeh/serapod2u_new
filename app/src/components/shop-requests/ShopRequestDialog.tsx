'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toTitleCaseWords } from '@/lib/utils'

/** Rows selected from `states` / `districts` below. */
interface StateOption {
    id: string
    state_name: string
}

interface DistrictOption {
    id: string
    district_name: string
    state_id: string
}

interface ShopRequestDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    defaultShopName?: string
    onSubmitted?: (requestId: string) => void
}

export function ShopRequestDialog({
    open,
    onOpenChange,
    defaultShopName = '',
    onSubmitted,
}: ShopRequestDialogProps) {
    const supabase = useMemo(() => createClient(), [])
    const [shopName, setShopName] = useState(defaultShopName)
    const [branch, setBranch] = useState('')
    const [contactName, setContactName] = useState('')
    const [contactPhone, setContactPhone] = useState('')
    const [state, setState] = useState('')
    const [address, setAddress] = useState('')
    const [notes, setNotes] = useState('')
    const [states, setStates] = useState<StateOption[]>([])
    const [districts, setDistricts] = useState<DistrictOption[]>([])
    const [selectedStateId, setSelectedStateId] = useState('')
    const [selectedDistrictId, setSelectedDistrictId] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [loadingLocations, setLoadingLocations] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')

    useEffect(() => {
        if (!open) return
        setShopName(defaultShopName)
        setSelectedStateId('')
        setSelectedDistrictId('')
        setState('')
        setBranch('')
        setError('')
        setSuccess('')
    }, [defaultShopName, open])

    useEffect(() => {
        if (!open) return

        const loadLocations = async () => {
            try {
                setLoadingLocations(true)

                const [{ data: statesData, error: statesError }, { data: districtsData, error: districtsError }] = await Promise.all([
                    supabase
                        .from('states')
                        .select('id, state_name')
                        .eq('is_active', true)
                        .order('state_name', { ascending: true }),
                    supabase
                        .from('districts')
                        .select('id, district_name, state_id')
                        .eq('is_active', true)
                        .order('district_name', { ascending: true }),
                ])

                if (statesError) throw statesError
                if (districtsError) throw districtsError

                setStates(statesData || [])
                setDistricts(districtsData || [])
            } catch (locationError: any) {
                console.error('Failed to load shop request locations:', locationError)
                setError('Failed to load state and branch options.')
            } finally {
                setLoadingLocations(false)
            }
        }

        void loadLocations()
    }, [open, supabase])

    const filteredDistricts = districts.filter((district) => district.state_id === selectedStateId)

    const selectedState = states.find((item) => item.id === selectedStateId) || null
    const selectedDistrict = filteredDistricts.find((item) => item.id === selectedDistrictId) || null

    const handleSubmit = async () => {
        if (!shopName.trim()) {
            setError('Shop name is required.')
            return
        }

        if (!selectedState) {
            setError('State is required.')
            return
        }

        if (!selectedDistrict) {
            setError('Branch is required.')
            return
        }

        try {
            setSubmitting(true)
            setError('')

            const response = await fetch('/api/shop-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopName,
                    branch: selectedDistrict.district_name,
                    contactName,
                    contactPhone,
                    state: selectedState.state_name,
                    address,
                    notes,
                }),
            })

            const result = await response.json()
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Failed to submit shop request.')
            }

            setSuccess('Your request has been submitted for HQ review. You will be notified after approval.')
            onSubmitted?.(result.requestId)
        } catch (submissionError: any) {
            setError(submissionError.message || 'Failed to submit shop request.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Request New Shop</DialogTitle>
                    <DialogDescription>
                        Submit the key details needed for HQ/Admin to create a proper shop masterdata record. This does not create a live shop immediately.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-2">
                        <Label htmlFor="shop-request-name">Shop Name</Label>
                        <Input id="shop-request-name" value={shopName} onChange={(event) => setShopName(event.target.value)} />
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="shop-request-branch">Branch</Label>
                            <Select
                                value={selectedDistrictId || 'none'}
                                onValueChange={(value) => {
                                    const nextDistrictId = value === 'none' ? '' : value
                                    setSelectedDistrictId(nextDistrictId)
                                    const nextDistrict = filteredDistricts.find((district) => district.id === nextDistrictId) || null
                                    setBranch(nextDistrict?.district_name || '')
                                }}
                                disabled={!selectedStateId || loadingLocations}
                            >
                                <SelectTrigger id="shop-request-branch">
                                    <SelectValue placeholder={selectedStateId ? 'Select branch' : 'Select state first'} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">None (Not defined)</SelectItem>
                                    {filteredDistricts.map((district) => (
                                        <SelectItem key={district.id} value={district.id}>
                                            {district.district_name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {!selectedStateId && (
                                <p className="text-xs text-muted-foreground italic">Select a state to view branches</p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="shop-request-state">State</Label>
                            <Select
                                value={selectedStateId || 'none'}
                                onValueChange={(value) => {
                                    const nextStateId = value === 'none' ? '' : value
                                    const nextState = states.find((item) => item.id === nextStateId) || null
                                    setSelectedStateId(nextStateId)
                                    setState(nextState?.state_name || '')
                                    setSelectedDistrictId('')
                                    setBranch('')
                                }}
                                disabled={loadingLocations}
                            >
                                <SelectTrigger id="shop-request-state">
                                    <SelectValue placeholder="Select state" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">None (Not defined)</SelectItem>
                                    {states.map((item) => (
                                        <SelectItem key={item.id} value={item.id}>
                                            {item.state_name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="shop-request-contact-name">Contact Name</Label>
                            <Input id="shop-request-contact-name" value={contactName} onChange={(event) => setContactName(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="shop-request-contact-phone">Contact Phone</Label>
                            <Input id="shop-request-contact-phone" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="shop-request-address">Address</Label>
                        <Textarea id="shop-request-address" value={address} onChange={(event) => setAddress(event.target.value)} rows={3} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="shop-request-notes">Notes</Label>
                        <Textarea id="shop-request-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="Optional context for HQ/Admin review" />
                    </div>
                    {error && <p className="text-sm text-red-600">{error}</p>}
                    {success && <p className="text-sm text-emerald-700">{success}</p>}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
                    <Button onClick={handleSubmit} disabled={submitting}>{submitting ? 'Submitting...' : 'Submit Request'}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}