export interface Organization {
  id: string
  org_name: string
  org_code: string
  org_type_code: string
  parent_org_id: string | null
  contact_name: string | null
  contact_title: string | null
  contact_phone: string | null
  contact_email: string | null
  address: string | null
  address_line2: string | null
  city: string | null
  state_id: string | null
  district_id: string | null
  postal_code: string | null
  country_code: string | null
  website: string | null
  logo_url: string | null
  latitude: number | null
  longitude: number | null
  is_active?: boolean | null
  default_warehouse_org_id: string | null
  settings?: Record<string, any> | null
  company_id?: string | null
  state?: string | null
  warranty_bonus?: number | null
  signature_type?: 'none' | 'upload' | 'electronic'
  signature_url?: string | null
  // Shop-specific fields (from CSV import)
  branch?: string | null
  sells_serapod_flavour?: boolean
  sells_sbox?: boolean
  sells_sbox_special_edition?: boolean
  hot_flavour_brands?: string | null
  payment_term_id?: string | null
}

export type OrganizationFormData = Partial<Organization>
