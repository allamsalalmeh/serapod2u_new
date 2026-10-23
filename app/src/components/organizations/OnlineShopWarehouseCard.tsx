'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, ShoppingBag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'

interface OnlineShopWarehouseCardProps {
  warehouse: { id: string; org_name: string; is_active?: boolean | null }
  parentHq: { id: string; org_name: string }
}

type ShopSetting = {
  explicitId: string | null
  defaultId: string | null
  /** undefined = the Outdoor shop warehouse setting is not installed yet */
  outdoorId?: string | null
  names: Record<string, string>
}

type Confirm = 'use' | 'follow' | 'outdoor_use' | 'outdoor_follow'

/** Which warehouse website orders (Outdoor + /store) ship from; distributor orders keep their own default. */
export default function OnlineShopWarehouseCard({ warehouse, parentHq }: OnlineShopWarehouseCardProps) {
  const supabase = createClient()
  const { toast } = useToast()
  const [isHqAdmin, setIsHqAdmin] = useState(false)
  const [setting, setSetting] = useState<ShopSetting | null>(null)
  const [notInstalled, setNotInstalled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void supabase.rpc('is_hq_admin').then(({ data, error }) => {
      if (!cancelled) setIsHqAdmin(!error && Boolean(data))
    })
    return () => {
      cancelled = true
    }
  }, [supabase])

  const refresh = async () => {
    setLoading(true)
    try {
      let { data: hq, error } = await supabase
        .from('organizations')
        .select('id, default_warehouse_org_id, storefront_warehouse_org_id, outdoor_warehouse_org_id')
        .eq('id', parentHq.id)
        .maybeSingle()
      let outdoorInstalled = true
      if (error && /outdoor_warehouse_org_id/i.test(error.message || '')) {
        outdoorInstalled = false
        ;({ data: hq, error } = await supabase
          .from('organizations')
          .select('id, default_warehouse_org_id, storefront_warehouse_org_id')
          .eq('id', parentHq.id)
          .maybeSingle())
      }
      if (error) {
        if (/storefront_warehouse_org_id/i.test(error.message || '')) {
          setNotInstalled(true)
          return
        }
        throw error
      }
      const row = hq as {
        default_warehouse_org_id?: string | null
        storefront_warehouse_org_id?: string | null
        outdoor_warehouse_org_id?: string | null
      } | null
      const explicitId = row?.storefront_warehouse_org_id || null
      const defaultId = row?.default_warehouse_org_id || null
      const outdoorId = outdoorInstalled ? row?.outdoor_warehouse_org_id || null : undefined
      const ids = [explicitId, defaultId, outdoorId].filter((id): id is string => Boolean(id))
      const names: Record<string, string> = { [warehouse.id]: warehouse.org_name }
      if (ids.some((id) => !names[id])) {
        const { data: orgs } = await supabase.from('organizations').select('id, org_name').in('id', ids)
        for (const org of (orgs || []) as Array<{ id: string; org_name: string }>) names[org.id] = org.org_name
      }
      setNotInstalled(false)
      setSetting({ explicitId, defaultId, outdoorId, names })
    } catch (err) {
      console.error('Failed to load online shop warehouse:', err)
      setSetting(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentHq.id, warehouse.id])

  const save = async (warehouseOrgId: string | null, purpose: 'online_shop' | 'outdoor_shop' = 'online_shop') => {
    setSaving(true)
    try {
      const response = await fetch('/api/organizations/set-default-warehouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hq_org_id: parentHq.id, warehouse_org_id: warehouseOrgId, purpose }),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error || 'Failed to change the online shop warehouse')
      await refresh()
      toast({ title: purpose === 'outdoor_shop' ? 'Outdoor shop warehouse updated' : 'Online shop warehouse updated', description: result?.message })
      setConfirm(null)
    } catch (err: any) {
      toast({ title: 'Unable to update', description: err?.message || 'Failed to change the online shop warehouse', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const effectiveId = setting ? setting.explicitId || setting.defaultId : null
  const effectiveName = effectiveId ? setting?.names[effectiveId] || 'Unknown warehouse' : null
  const defaultName = setting?.defaultId ? setting.names[setting.defaultId] || 'Unknown warehouse' : null
  const shipsHere = effectiveId === warehouse.id
  const chosenHere = setting?.explicitId === warehouse.id
  const outdoorInstalled = setting?.outdoorId !== undefined
  const outdoorId = setting?.outdoorId || effectiveId
  const outdoorName = outdoorId ? setting?.names[outdoorId] || 'Unknown warehouse' : null
  const outdoorHere = setting?.outdoorId === warehouse.id

  return (
    <>
      <Card className="border-orange-200 bg-orange-50/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShoppingBag className="h-4 w-4 text-orange-700" />
            Online Shop Orders
          </CardTitle>
          <CardDescription>
            Website orders are sold against, and shipped from, one warehouse under {parentHq.org_name}. The Outdoor shop can use its own
            warehouse instead. Distributor orders are not affected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading online shop warehouse…
            </div>
          ) : notInstalled ? (
            <p className="text-sm text-muted-foreground">
              This setting is not installed yet. Once the online shop warehouse migration is applied, you can choose it here.
            </p>
          ) : (
            <>
              {shipsHere ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3">
                  <Badge className="mb-1 bg-emerald-600 hover:bg-emerald-600">
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                    Ships website orders
                  </Badge>
                  <p className="text-sm text-emerald-900">
                    {chosenHere
                      ? 'Website orders take their stock from this warehouse.'
                      : 'Website orders follow the default fulfillment warehouse, which is this one.'}
                  </p>
                </div>
              ) : (
                <div className="rounded-md border border-border bg-background px-3 py-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Website orders ship from</p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {effectiveName || 'No warehouse is set'}
                    {effectiveName && !setting?.explicitId ? (
                      <span className="font-normal text-muted-foreground"> · following the default</span>
                    ) : null}
                  </p>
                </div>
              )}
              {isHqAdmin ? (
                <div className="flex flex-wrap gap-2">
                  {!chosenHere && warehouse.is_active !== false ? (
                    <Button type="button" onClick={() => setConfirm('use')} disabled={saving}>
                      Ship Website Orders From This Warehouse
                    </Button>
                  ) : null}
                  {chosenHere ? (
                    <Button type="button" variant="outline" onClick={() => setConfirm('follow')} disabled={saving}>
                      Follow the Default Warehouse Instead
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Only HQ Admin can change the online shop warehouse.</p>
              )}

              {outdoorInstalled ? (
                <div className="space-y-2 border-t border-orange-200 pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outdoor shop</p>
                  {outdoorHere ? (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3">
                      <Badge className="mb-1 bg-emerald-600 hover:bg-emerald-600">
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                        Sells Outdoor orders
                      </Badge>
                      <p className="text-sm text-emerald-900">Outdoor shop orders take their stock from this warehouse.</p>
                    </div>
                  ) : (
                    <p className="text-sm text-foreground">
                      Outdoor orders ship from <span className="font-medium">{outdoorName || 'no warehouse yet'}</span>
                      {!setting?.outdoorId && outdoorName ? (
                        <span className="text-muted-foreground"> · same as the other website orders</span>
                      ) : null}
                    </p>
                  )}
                  {isHqAdmin ? (
                    <div className="flex flex-wrap gap-2">
                      {!outdoorHere && warehouse.is_active !== false ? (
                        <Button type="button" variant="outline" onClick={() => setConfirm('outdoor_use')} disabled={saving}>
                          Sell Outdoor Orders From This Warehouse
                        </Button>
                      ) : null}
                      {outdoorHere ? (
                        <Button type="button" variant="outline" onClick={() => setConfirm('outdoor_follow')} disabled={saving}>
                          Use the Website Warehouse for Outdoor
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'follow'
                ? 'Follow the default warehouse?'
                : confirm === 'outdoor_use'
                  ? `Sell Outdoor orders from ${warehouse.org_name}?`
                  : confirm === 'outdoor_follow'
                    ? 'Use the website warehouse for Outdoor?'
                    : `Ship website orders from ${warehouse.org_name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {confirm === 'follow'
                ? `Website orders will take their stock from the default fulfillment warehouse${defaultName ? ` (${defaultName})` : ''}. Products with no stock there will show as sold out on the website.`
                : confirm === 'outdoor_use'
                  ? `Outdoor shop orders will take their stock from ${warehouse.org_name}. Outdoor products with no stock there will show as sold out, so move stock here first.\n\nThe Serapod2U store keeps using ${effectiveName || 'the website warehouse'}, and distributor orders are unchanged. Orders that already shipped are not changed.`
                  : confirm === 'outdoor_follow'
                    ? `Outdoor shop orders will take their stock from ${effectiveName || 'the website warehouse'}, like the other website orders. Outdoor products with no stock there will show as sold out.`
                    : `Website orders will take their stock from ${warehouse.org_name}. Products with no stock there will show as sold out on the website, so move stock here first.\n\nDistributor orders keep using ${defaultName || 'their default warehouse'}. Orders that already shipped are not changed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault()
                if (confirm === 'outdoor_use') void save(warehouse.id, 'outdoor_shop')
                else if (confirm === 'outdoor_follow') void save(null, 'outdoor_shop')
                else void save(confirm === 'follow' ? null : warehouse.id)
              }}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : confirm === 'follow' ? 'Follow Default' : confirm === 'outdoor_follow' ? 'Use Website Warehouse' : confirm === 'outdoor_use' ? 'Sell Outdoor From Here' : 'Ship From Here'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
