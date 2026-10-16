"use client"

import { useState, type ReactNode } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MONITOR_TIMEZONE, STATUS_LABELS, type MonitorStatus } from "@/lib/notifications/monitor/monitorCore"

const TONES: Record<MonitorStatus, string> = {
    pending: "bg-amber-50 text-amber-800 border-amber-200",
    sent: "bg-emerald-50 text-emerald-800 border-emerald-200",
    delivered: "bg-sky-50 text-sky-800 border-sky-200",
    read: "bg-cyan-50 text-cyan-800 border-cyan-200",
    failed: "bg-red-50 text-red-800 border-red-200",
    resolved: "bg-violet-50 text-violet-800 border-violet-200",
    other: "bg-slate-50 text-slate-700 border-slate-200",
}

export function StatusBadge({ status }: { status: MonitorStatus }) {
    return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[status]}`}>{STATUS_LABELS[status]}</span>
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: MONITOR_TIMEZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })

/** A timestamp shown in Malaysia time. */
export function formatMonitorTime(value: string | null | undefined) {
    if (!value) return "—"
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? "—" : timeFormat.format(date)
}

/** "26 Sep 2026 – 2 Oct 2026" from YYYY-MM-DD days. */
export function formatRange(from: string, to: string) {
    const day = (value: string) => dayFormat.format(new Date(`${value}T00:00:00Z`))
    return from === to ? day(from) : `${day(from)} – ${day(to)}`
}

export interface MenuAction { label: string; onSelect: () => void; disabled?: boolean; heading?: false }
export interface MenuHeading { heading: true; label: string }

/** A keyboard-accessible action menu (Radix popover with real buttons). */
export function ActionMenu({ trigger, items, align = "end" }: { trigger: ReactNode; items: Array<MenuAction | MenuHeading | "separator">; align?: "start" | "end" }) {
    const [open, setOpen] = useState(false)
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent align={align} className="w-72 p-1">
                <div role="menu" className="flex flex-col">
                    {items.map((item, index) => item === "separator"
                        ? <div key={index} role="separator" className="my-1 h-px bg-slate-100" />
                        : item.heading
                            ? <p key={index} className="px-2 pb-1 pt-1.5 text-[11px] text-slate-500">{item.label}</p>
                            : (
                                <button
                                    key={index}
                                    type="button"
                                    role="menuitem"
                                    disabled={item.disabled}
                                    onClick={() => { setOpen(false); item.onSelect() }}
                                    className="rounded px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-slate-400"
                                >
                                    {item.label}
                                </button>
                            ))}
                </div>
            </PopoverContent>
        </Popover>
    )
}
