'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Search, X, User } from 'lucide-react'

interface Employee {
    id: string
    full_name: string | null
    email: string
    avatar_url: string | null
    employee_no: string | null
    department_name: string | null
}

interface EmployeeSearchPickerProps {
    value: string
    onChange: (userId: string, employee?: Employee) => void
    placeholder?: string
    disabled?: boolean
    className?: string
}

export default function EmployeeSearchPicker({
    value,
    onChange,
    placeholder = 'Search employee by name or email…',
    disabled = false,
    className = '',
}: EmployeeSearchPickerProps) {
    const [search, setSearch] = useState('')
    const [employees, setEmployees] = useState<Employee[]>([])
    const [loading, setLoading] = useState(false)
    const [open, setOpen] = useState(false)
    const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Close dropdown on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [])

    // Fetch employees matching search
    const fetchEmployees = useCallback(async (q: string) => {
        if (q.length < 1) { setEmployees([]); return }
        setLoading(true)
        try {
            const supabase = createClient()
            // Operational pickers list employees HR has onboarded (employment
            // anchors awaiting onboarding or reset are not selectable).
            const { data } = await (supabase as any)
                .from('users')
                .select('id, full_name, email, avatar_url, hr_employees!hr_employees_user_id_fkey!inner(employee_no, onboarding_status)')
                .eq('hr_employees.onboarding_status', 'completed')
                .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
                .limit(15)

            if (data) {
                setEmployees(data.map((u: any) => {
                    const employment = Array.isArray(u.hr_employees) ? u.hr_employees[0] : u.hr_employees
                    return {
                        id: u.id,
                        full_name: u.full_name,
                        email: u.email,
                        avatar_url: u.avatar_url,
                        employee_no: employment?.employee_no ?? null,
                        department_name: null,
                    }
                }))
            }
        } catch (e) {
            console.error('Employee search failed:', e)
        }
        setLoading(false)
    }, [])

    // Debounced search
    const handleSearch = (q: string) => {
        setSearch(q)
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => fetchEmployees(q), 300)
    }

    // Load selected employee on mount if value is set
    useEffect(() => {
        if (value && !selectedEmployee) {
            const supabase = createClient()
            supabase
                .from('users')
                .select('id, full_name, email, avatar_url')
                .eq('id', value)
                .maybeSingle()
                .then(({ data }) => {
                    if (data) {
                        setSelectedEmployee({
                            id: data.id,
                            full_name: data.full_name,
                            email: data.email,
                            avatar_url: data.avatar_url,
                            employee_no: null,
                            department_name: null,
                        })
                    }
                })
        }
    }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

    const handleSelect = (emp: Employee) => {
        setSelectedEmployee(emp)
        setOpen(false)
        setSearch('')
        onChange(emp.id, emp)
    }

    const handleClear = () => {
        setSelectedEmployee(null)
        onChange('')
        setSearch('')
    }

    const initials = (name: string | null) => {
        if (!name) return '?'
        return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    }

    // If we have a selected employee, show the chip
    if (selectedEmployee) {
        return (
            <div className={`flex items-center gap-2 rounded-md border px-3 py-2 bg-gray-50 ${className}`}>
                <Avatar className="h-7 w-7">
                    <AvatarImage src={selectedEmployee.avatar_url || undefined} />
                    <AvatarFallback className="text-[10px] bg-blue-100 text-blue-700">{initials(selectedEmployee.full_name)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{selectedEmployee.full_name || selectedEmployee.email}</div>
                    {selectedEmployee.employee_no && (
                        <div className="text-[10px] text-gray-500">{selectedEmployee.employee_no}</div>
                    )}
                </div>
                {!disabled && (
                    <button type="button" onClick={handleClear} className="text-gray-400 hover:text-gray-600">
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>
        )
    }

    return (
        <div ref={wrapperRef} className={`relative ${className}`}>
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                    value={search}
                    onChange={e => { handleSearch(e.target.value); setOpen(true) }}
                    onFocus={() => search.length > 0 && setOpen(true)}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="pl-9"
                />
            </div>

            {open && (search.length > 0 || employees.length > 0) && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-lg border bg-white shadow-lg max-h-64 overflow-y-auto">
                    {loading ? (
                        <div className="text-center py-4 text-sm text-gray-500">Searching...</div>
                    ) : employees.length === 0 ? (
                        <div className="text-center py-4 text-sm text-gray-400">
                            <User className="h-5 w-5 mx-auto mb-1 text-gray-300" />
                            No employees found
                        </div>
                    ) : (
                        employees.map(emp => (
                            <button
                                key={emp.id}
                                type="button"
                                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 text-left transition-colors"
                                onClick={() => handleSelect(emp)}
                            >
                                <Avatar className="h-8 w-8 shrink-0">
                                    <AvatarImage src={emp.avatar_url || undefined} />
                                    <AvatarFallback className="text-[10px] bg-blue-100 text-blue-700">{initials(emp.full_name)}</AvatarFallback>
                                </Avatar>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{emp.full_name || emp.email}</div>
                                    <div className="text-[10px] text-gray-500 truncate">{emp.email}</div>
                                </div>
                                <div className="flex flex-col items-end gap-0.5 shrink-0">
                                    {emp.employee_no && (
                                        <Badge variant="outline" className="text-[9px] px-1.5">{emp.employee_no}</Badge>
                                    )}
                                    {emp.department_name && (
                                        <span className="text-[9px] text-gray-400">{emp.department_name}</span>
                                    )}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    )
}
