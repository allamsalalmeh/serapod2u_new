import { createAdminClient } from "@/lib/supabase/admin";
import {
  OUTDOOR_NAV,
  outdoorSpecLabel,
  outdoorStaticImage,
} from "@/lib/outdoor/merch";
import { getStorageUrl } from "@/lib/utils";
import { hasPricedVariant, isOutdoorPriced } from "@/lib/outdoor/pricing";
import {
  listProducts,
  listCategories,
  getProductDetail,
  selectStorefrontProductMedia,
  type StorefrontCategory,
  type StorefrontProduct,
  type StorefrontProductDetail,
  type StorefrontVariant,
} from "@/lib/storefront/products";

export type OutdoorCatalogScope = {
  categoryIds: string[];
  brandId: string | null;
  matchedBy: "env" | "name" | "none";
};

function isOutdoorName(name: string | null | undefined) {
  return /outdoor/i.test(String(name || "").trim());
}

/** Photos come from master data; the bundled packshot only fills a product that has none. */
function withOutdoorAppearance(product: StorefrontProduct): StorefrontProduct {
  const specLabel = product.specLabel || outdoorSpecLabel(product.product_name);
  const colorSwatches = (product.colorSwatches || []).map((swatch) => ({
    ...swatch,
    imageUrl:
      swatch.imageUrl ||
      product.image_url ||
      outdoorStaticImage(product.product_name, swatch.hex),
  }));
  return {
    ...product,
    image_url: product.image_url || outdoorStaticImage(product.product_name, "burgundy"),
    outdoorNav: product.outdoorNav || "new",
    specLabel,
    colorSwatches,
  };
}

/**
 * Resolve which catalogue Outdoor may show.
 * Priority:
 *  1) OUTDOOR_CATEGORY_ID / OUTDOOR_BRAND_ID env
 *  2) Auto-detect categories/brands whose name contains "Outdoor"
 * Never falls back to the full shared catalogue.
 */
export async function resolveOutdoorCatalogScope(): Promise<OutdoorCatalogScope> {
  const categoryIdEnv = String(process.env.OUTDOOR_CATEGORY_ID || "").trim();
  const brandIdEnv = String(process.env.OUTDOOR_BRAND_ID || "").trim();

  if (categoryIdEnv || brandIdEnv) {
    return {
      categoryIds: categoryIdEnv ? [categoryIdEnv] : [],
      brandId: brandIdEnv || null,
      matchedBy: "env",
    };
  }

  const supabase: any = createAdminClient();
  const [{ data: cats }, { data: brands }] = await Promise.all([
    supabase.from("product_categories").select("id, category_name"),
    supabase.from("brands").select("id, brand_name"),
  ]);

  const categoryIds = (cats || [])
    .filter((c: any) => isOutdoorName(c.category_name))
    .map((c: any) => String(c.id));

  const outdoorBrand = (brands || []).find((b: any) =>
    isOutdoorName(b.brand_name),
  );

  if (categoryIds.length === 0 && !outdoorBrand) {
    return { categoryIds: [], brandId: null, matchedBy: "none" };
  }

  return {
    categoryIds,
    brandId: outdoorBrand ? String(outdoorBrand.id) : null,
    matchedBy: "name",
  };
}

export async function listOutdoorCategories(): Promise<StorefrontCategory[]> {
  const scope = await resolveOutdoorCatalogScope();
  if (scope.matchedBy === "none") return [];

  const all = await listCategories();
  if (scope.categoryIds.length > 0) {
    const allowed = new Set(scope.categoryIds);
    return all.filter((c) => allowed.has(c.id));
  }
  return all.filter((c) => isOutdoorName(c.name));
}

export async function listOutdoorProducts(params: {
  search?: string;
  category?: string;
  sort?: "newest" | "price_asc" | "price_desc" | "name_asc";
  page?: number;
  limit?: number;
  /** Staff views list products without a price too; shoppers never see them. */
  includeUnpriced?: boolean;
}): Promise<{
  products: StorefrontProduct[];
  total: number;
  page: number;
  limit: number;
  scope: OutdoorCatalogScope;
}> {
  const scope = await resolveOutdoorCatalogScope();
  const page = params.page || 1;
  const limit = params.limit || 48;
  const shown = (list: StorefrontProduct[]) =>
    params.includeUnpriced ? list : list.filter(isOutdoorPriced);

  if (scope.matchedBy === "none") {
    return { products: [], total: 0, page, limit, scope };
  }

  let category = params.category || "";
  if (
    category &&
    scope.categoryIds.length > 0 &&
    !scope.categoryIds.includes(category)
  ) {
    category = "";
  }
  if (!category && scope.categoryIds.length === 1) {
    category = scope.categoryIds[0];
  }

  // Multiple outdoor categories: merge
  if (!category && scope.categoryIds.length > 1) {
    const pages = await Promise.all(
      scope.categoryIds.map((id) =>
        listProducts({
          search: params.search,
          category: id,
          brandId: scope.brandId || undefined,
          sort: params.sort,
          page: 1,
          limit,
          channel: "outdoor",
        }),
      ),
    );
    const map = new Map<string, StorefrontProduct>();
    for (const chunk of pages) {
      for (const p of chunk.products) map.set(p.id, p);
    }
    let products = Array.from(map.values());
    if (params.sort === "price_asc") {
      products.sort(
        (a, b) =>
          (a.starting_price ?? Infinity) - (b.starting_price ?? Infinity),
      );
    } else if (params.sort === "price_desc") {
      products.sort(
        (a, b) => (b.starting_price ?? 0) - (a.starting_price ?? 0),
      );
    } else if (params.sort === "name_asc") {
      products.sort((a, b) => a.product_name.localeCompare(b.product_name));
    }
    const merged = shown(await withOutdoorStoreProducts(products, limit));
    products = merged.slice(0, limit).map(withOutdoorAppearance);
    return { products, total: products.length, page: 1, limit, scope };
  }

  const result = await listProducts({
    search: params.search,
    category: category || undefined,
    brandId: scope.brandId || undefined,
    sort: params.sort,
    page,
    limit,
    channel: "outdoor",
  });

  // Never leak non-outdoor items into Outdoor UI
  const products = result.products.filter((p) => {
    if (scope.categoryIds.length > 0)
      return scope.categoryIds.includes(p.category_id);
    if (scope.brandId) return p.brand_id === scope.brandId;
    return isOutdoorName(p.category_name) || isOutdoorName(p.brand_name);
  });

  const merged = shown(await withOutdoorStoreProducts(products, limit));
  return {
    products: merged.slice(0, limit).map(withOutdoorAppearance),
    total: merged.length,
    page: result.page,
    limit: result.limit,
    scope,
  };
}

async function withOutdoorStoreProducts(
  products: StorefrontProduct[],
  limit: number,
) {
  const extra = await listProducts({
    outdoorOnly: true,
    sort: "name_asc",
    page: 1,
    limit,
  });
  const seen = new Set(products.map((product) => product.id));
  return [
    ...products,
    ...extra.products.filter((product) => !seen.has(product.id)),
  ];
}

async function productPhoto(
  productId: string,
  variants: StorefrontVariant[],
) {
  const supabase: any = createAdminClient();
  const { data } = await supabase
    .from("product_images")
    .select("image_url, is_active, is_primary, sort_order")
    .eq("product_id", productId);
  const picked = selectStorefrontProductMedia(data, variants).imageUrl;
  return picked ? getStorageUrl(picked) || picked : null;
}

export async function getOutdoorProductDetail(
  productId: string,
): Promise<StorefrontProductDetail | null> {
  const product = await getProductDetail(productId, "outdoor");
  if (!product) return null;

  const scope = await resolveOutdoorCatalogScope();
  if (scope.matchedBy === "none") return null;

  const supabase: any = createAdminClient();
  let rowQuery = await supabase
    .from("products")
    .select("category_id, brand_id, group_id, outdoor_hidden, outdoor_only")
    .eq("id", productId)
    .maybeSingle();
  if (
    rowQuery.error &&
    /outdoor_hidden|outdoor_only/i.test(rowQuery.error.message || "")
  ) {
    rowQuery = await supabase
      .from("products")
      .select("category_id, brand_id, outdoor_hidden")
      .eq("id", productId)
      .maybeSingle();
  }
  if (rowQuery.error && /outdoor_hidden/i.test(rowQuery.error.message || "")) {
    rowQuery = await supabase
      .from("products")
      .select("category_id, brand_id")
      .eq("id", productId)
      .maybeSingle();
  }
  const row = rowQuery.data;
  const variants = product.variants.filter(
    (variant) => !variant.attributes?.outdoor_only_variant,
  );
  if (!hasPricedVariant(variants)) return null;
  const priced = {
    ...product,
    image_url: await productPhoto(productId, variants),
    variants,
  };
  if (row?.outdoor_only) {
    if (!row.group_id) return null;
    return priced;
  }

  if (scope.categoryIds.length > 0) {
    if (row?.category_id && scope.categoryIds.includes(String(row.category_id)))
      return priced;
    if (isOutdoorName(product.category_name)) return priced;
    return null;
  }

  if (scope.brandId) {
    if (row?.brand_id && String(row.brand_id) === scope.brandId) return priced;
    if (isOutdoorName(product.brand_name)) return priced;
    return null;
  }

  if (isOutdoorName(product.category_name) || isOutdoorName(product.brand_name))
    return priced;
  return null;
}

export function outdoorCategoryNavFromProducts(_products: StorefrontProduct[]) {
  return OUTDOOR_NAV.map((item) => ({
    key: item.key,
    label: item.label,
    href: `/outdoor/shop?collection=${item.key}`,
    icon: item.key,
  }));
}

export async function getOutdoorCategoryNav() {
  const { products } = await listOutdoorProducts({ sort: "newest", limit: 24 });
  return outdoorCategoryNavFromProducts(products);
}
