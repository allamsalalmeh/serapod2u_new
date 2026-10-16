'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save, Tags } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'

interface ManufacturerCategoriesCardProps {
  manufacturer: { id: string; org_name: string }
}

type Category = { id: string; category_name: string }

export function diffCategorySelection(saved: string[], selected: string[]) {
  const before = new Set(saved)
  const after = new Set(selected)
  return {
    add: selected.filter((id) => !before.has(id)),
    remove: saved.filter((id) => !after.has(id)),
  }
}

/** Product Master categories a manufacturer makes, independent of whether it has products yet. */
export default function ManufacturerCategoriesCard({ manufacturer }: ManufacturerCategoriesCardProps) {
  const supabase = createClient()
  const { toast } = useToast()
  const [categories, setCategories] = useState<Category[]>([])
  const [saved, setSaved] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [fromProducts, setFromProducts] = useState<string[]>([])
  const [notInstalled, setNotInstalled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const db = supabase as any
      const [cats, links, products] = await Promise.all([
        db.from('product_categories').select('id, category_name').eq('is_active', true).order('category_name'),
        db.from('manufacturer_product_categories').select('category_id').eq('manufacturer_id', manufacturer.id),
        db.from('products').select('category_id').eq('manufacturer_id', manufacturer.id).not('category_id', 'is', null),
      ])
      if (links.error) {
        if (/manufacturer_product_categories/i.test(links.error.message || '')) {
          setNotInstalled(true)
          return
        }
        throw links.error
      }
      if (cats.error) throw cats.error
      const ids = ((links.data || []) as Array<{ category_id: string }>).map((row) => row.category_id)
      setNotInstalled(false)
      setCategories((cats.data || []) as Category[])
      setSaved(ids)
      setSelected(ids)
      setFromProducts(Array.from(new Set(((products.data || []) as Array<{ category_id: string }>).map((row) => row.category_id))))
    } catch (err) {
      console.error('Failed to load manufacturer categories:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manufacturer.id])

  const { add, remove } = useMemo(() => diffCategorySelection(saved, selected), [saved, selected])
  const changed = add.length > 0 || remove.length > 0
  const missingFromProducts = fromProducts.filter((id) => !selected.includes(id) && categories.some((c) => c.id === id))

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => (checked ? Array.from(new Set([...current, id])) : current.filter((value) => value !== id)))
  }

  const save = async () => {
    setSaving(true)
    try {
      const db = supabase as any
      if (remove.length > 0) {
        const { error } = await db
          .from('manufacturer_product_categories')
          .delete()
          .eq('manufacturer_id', manufacturer.id)
          .in('category_id', remove)
        if (error) throw error
      }
      if (add.length > 0) {
        const { data: auth } = await supabase.auth.getUser()
        const { error } = await db
          .from('manufacturer_product_categories')
          .insert(add.map((categoryId) => ({ manufacturer_id: manufacturer.id, category_id: categoryId, created_by: auth?.user?.id ?? null })))
        if (error) throw error
      }
      await refresh()
      toast({ title: 'Product categories saved', description: `${manufacturer.org_name} updated.` })
    } catch (err: any) {
      const denied = /row-level security|permission denied/i.test(err?.message || '')
      toast({
        title: 'Unable to save',
        description: denied ? 'You do not have permission to change this manufacturer.' : err?.message || 'Failed to save product categories',
        variant: 'destructive',
      })
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Tags className="h-4 w-4" />
          Product Categories
        </CardTitle>
        <CardDescription>
          Product Master categories this manufacturer makes. A manufacturer can have more than one, even before any product is linked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading categories…
          </div>
        ) : notInstalled ? (
          <p className="text-sm text-muted-foreground">
            This setting is not installed yet. Once the manufacturer category migration is applied, you can choose categories here.
          </p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active product categories. Add them in Product Master first.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {categories.map((category) => (
                <label
                  key={category.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={selected.includes(category.id)}
                    onCheckedChange={(checked) => toggle(category.id, checked)}
                    disabled={saving}
                  />
                  <span className="flex-1">{category.category_name.trim()}</span>
                  {fromProducts.includes(category.id) ? (
                    <Badge variant="secondary" className="text-xs font-normal">Has products</Badge>
                  ) : null}
                </label>
              ))}
            </div>
            {missingFromProducts.length > 0 ? (
              <p className="text-xs text-amber-700">
                This manufacturer already has products in{' '}
                {missingFromProducts.map((id) => categories.find((c) => c.id === id)?.category_name.trim()).join(', ')}, which is not ticked.
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => void save()} disabled={!changed || saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save Categories
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
