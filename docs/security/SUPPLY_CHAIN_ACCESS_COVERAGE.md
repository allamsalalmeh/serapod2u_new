# Supply Chain — Security & Access enforcement and coverage

Status 2026-10-11, branch `issues-fixing-oct2`. Migration `20261031100000_sa_inventory_stock_view.sql` is **not applied**
anywhere. Staging facts below come from read-only catalogue queries. Localhost shares the staging database.

Commit status: the database fix, its harness, `inventory-stock.ts` and the assistant tool gate are committed. The navigation
and page-guard wiring is still uncommitted:

* files: `nav-access.ts` (client + server) destinations, `Sidebar.tsx`, `SupplyChainLandingView` / `SupplyChainTopNav`,
  `supplyChainNav.ts` `viewAllowed`, `DashboardContent.tsx`, `app/supply-chain/{_lib,page,[...slug]/page}`, plus their tests;
* reason: it is built on the untracked navigation base (`nav-access.ts`, `useNavAccess`, `AccessState`) from earlier
  sessions, and it is committed together with that base.

## 1. Incident: inventory readable after Supply Chain Full Access was revoked

`orderapp@dev.com` (HQ, GUEST level 50) had Supply Chain Full Access granted and then revoked. The `sa_role_assignments` row
is `revoked`, and only Employee Self-Service is active. **The revocation worked.** S&A has no stale grant and no cache that
survives a request. The problem was that the screens and data paths below never asked S&A:

| Surface | Why it ignored the revocation |
|---|---|
| Sidebar "Supply Chain" | The menu item had no access rule at all, so it was always shown. |
| `/supply-chain` and `/supply-chain/*` | `getSupplyChainPageContext` returned `canViewSupplyChain = true`, hard-coded. |
| Landing cards / top navigation | Only legacy org-type and role-level rules (`supplyChainNav.ts`). An HQ account always saw Products, Orders, QR and Inventory. |
| Order Details "Unauthorized" | This was only correct by accident: `view-order` used the legacy `role_level <= 40` rule, and the user is level 50. |
| **Inventory data** | `InventoryView` reads PostgREST directly from the browser: `vw_inventory_on_hand`, `vw_manual_stock_balance`, `product_inventory` and `stock_movements`. |
| `vw_inventory_on_hand`, `vw_manual_stock_balance`, `v_low_stock_alerts`, `v_stock_movements_display` | Owned by a superuser, **not** `security_invoker`, granted to `authenticated` (Phase 0B allowlist), with **no organization filter**. Any signed-in account in any organization read every organization's stock, low-stock lines and movement history. |
| `product_inventory` SELECT | `inventory_read_org_hierarchy` = tenant rule only (`can_access_org OR is_hq_admin`). The Final Wave gate left every Supply Chain SELECT untouched (`read_perm = null`). |
| `product_inventory` `inventory_org_manage` | A `FOR ALL` policy. After the Final Wave rewrite its expression reduces to `can_access_org(organization_id)` in S&A modes, and `FOR ALL` also grants SELECT. |
| Module assistant (Supply Chain) | Tools such as `inventorySummary` and `lowStockItems` run with the **service client**, gated only by `hr.ai.use` (legacy `() => true`). |

No existing permission meant "view stock on hand". `inventory.report.view` covers movement/stock reports,
`inventory.transfer.view` covers transfers, and `inventory.stock_count.view` covers stock counts.

## 2. What changed

* **Permission `inventory.stock.view` ("View Inventory")** is a new key. It is seeded `NEW_ENFORCED` where the Inventory
  module is already S&A-authoritative (`inventory.report.view` NEW_ENFORCED/LEGACY_RETIRED, as on staging), and `SHADOW`
  elsewhere, where legacy keeps today's tenant rule. No existing mode changes.
* **Stock read rule**, the same everywhere (`sa_inventory_stock_row_visible`):
  * The tenant rule always applies, unchanged.
  * While `inventory.stock.view` is S&A-authoritative, the row's organization must also be in the caller's S&A scope for one of
  `sa_inventory_stock_read_permissions()`: View Inventory itself, or a stock workflow permission whose screens show balances.
  Those are adjustment, stock count, transfer request/approve/dispatch/receive, warehouse receipt/shipment, stock reports,
  opening balance and stock configuration.
  * `product_inventory` only: a holder of `supply_chain.order.create` keeps reading availability inside the tenant rule, because
  order forms read the seller's stock.
  * The scope is computed once per statement (InitPlan) from `sa_readable_organizations`. It includes assignments, scopes,
  delegation and Root Access.
* **`product_inventory`**: the SELECT policy uses the rule. `inventory_org_manage` is split into INSERT/UPDATE/DELETE with
  byte-identical expressions, so writes are unchanged and it no longer grants SELECT.
* **The four views** keep their columns, grants and definitions. They gain the rule and `security_barrier`. They are also
  limited to the tenant in legacy mode, which closes the cross-organization leak.
* **Inventory Viewer** (`inventory-viewer`): a standard policy holding exactly `inventory.stock.view`. It applies to
  HQ/DIST/WH and is assigned to no one.
* **Supply Chain Full Access** gains `inventory.stock.view` via `sa_extend_standard_policy`, with an audit row per holder.
  Warehouse Manager/Operator are not extended, because their workflow permissions already read stock in their scope.
* **App**:
  * One destination table (`nav-access.ts`: `supply-chain` plus `supply-chain/<view>` for every screen) drives the sidebar, the
  landing cards, the top navigation, the in-app view switch and the server page guards, including direct URLs and order deep
  links.
  * The legacy org-type/level rules in `supplyChainNav.ts` still apply on top, as business boundaries.
  * Supply Chain assistant tools decide per tool through S&A (`SC_TOOL_PERMISSIONS`).

## 3. Coverage matrix

Legend:

* **Full**: page/API and data paths verified to decide through S&A.
* **Partial**: some paths S&A, others tenant-only.
* **Legacy**: decided by a legacy role-level rule.
* **Missing**: no authorization beyond sign-in.
* **Migration**: needs a separate migration.

| Feature | Permission(s) | UI (nav/landing) | Page guard | API | DB / RLS | Classification |
|---|---|---|---|---|---|---|
| Supply Chain module | any SC permission, or `platform.organization.manage` | S&A (this change) | S&A (this change) | n/a | n/a | **Full** |
| Product Catalogue (list) | `product.catalog.view` / `.manage` | S&A | S&A | 3 routes on `.manage` | `products` SELECT = `is_active OR is_hq_admin` (reference data), writes gated `.manage` | **Partial**: reads are not permission-gated (by design) |
| View Orders | `supply_chain.order.*`, `document.*` | S&A | S&A + legacy L40 for `view-order` | order routes guard create/approve | `orders_select` = buyer/seller/warehouse org (tenant), not permission | **Partial**: any member of a party org reads its orders via PostgREST |
| Create Order | `supply_chain.order.create` | S&A | S&A | `/api/orders/save`, D2H routes (8) | `sa_orders_api_write_guard`; H2M via `sa_actor_may_create_h2m` | **Migration**: `20261028100000` unapplied; button wiring uncommitted |
| Approve Order | `supply_chain.order.approve` | S&A | S&A | 1 route | `orders_approve` RPC guard + maker/checker SoD; status write-guard | **Full** (write path); reads as View Orders |
| View Inventory | `inventory.stock.view` + stock workflow perms | S&A | S&A | no unguarded GET; movements/ship-metrics on `inventory.report.view` | `product_inventory` + 4 views filtered (this change) | **Full** with 20261031100000 (applied on staging) + **20261107100000** (unapplied): `stock_movements` and both movement views on the same scope, cost/balance fields masked for partners. |
| Add Stock | `inventory.adjustment.post` | S&A | S&A | RPC | `post_manual_stock_addition` guard; `product_inventory` write guard | **Full** |
| Stock Adjustment (stock count) | `inventory.stock_count.*`, `adjustment.post` | S&A | S&A | 5 routes | count RPC guards / readiness | **Migration**: `20261019100000/110000` unapplied |
| Stock Transfer | `inventory.transfer.*` | S&A | S&A | 1 route + RPCs | transfer RPC guards; writes workflow-only | **Partial / Legacy**: `stock_transfers_manage_hq` (FOR ALL) lets **any HQ account read all transfers**; `stock_transfers_view_all` uses legacy staff L40 |
| QR Operations | `qr.batch.manage`, `manufacturing.production.manage` | S&A | S&A | 5 routes | writes gated; `qr_batches` SELECT = `sa_actor_is_staff(40)` | **Legacy** reads |
| Warehouse receive / ship | `warehouse.receipt.post`, `warehouse.shipment.manage` | S&A | S&A | 6 / 4 routes | RPC guards; `vw_manual_stock_balance` filtered | **Full** |
| Returns | `inventory.return.request` / `.manage` | S&A | S&A | 3 routes on `.request` | writes gated; `return_cases_select` = `return_current_user_is_manager()` | **Legacy** reads |
| Organizations | `platform.organization.manage` | S&A + legacy HQ L30 | S&A | org routes | `organizations` writes gated | **Partial**: list read is reference data |
| Inventory Settings | `inventory.stock_config.manage` | S&A + legacy HQ L10 | S&A | stock-config routes | RPC guard / RLS gate | **Full** (the client keeps the L10 org rule) |
| SC assistant tools | per tool | n/a | n/a | S&A per tool (this change) | service client | **Full** for SC tools; Finance/CG tools are still only `hr.ai.use` |

## 4. Follow-ups (not done here)

1. **`stock_transfers_manage_hq` (FOR ALL)**: any HQ account reads every transfer. Split it like `inventory_org_manage`, and
   gate SELECT with `inventory.transfer.view` + scope.
2. ~~**`stock_movements` SELECT**~~ — done in `20261107100000_sa_stock_movement_access.sql` (section 6).
3. **`orders_select`**: tenant only. Gate reads with order permissions plus the party rule (buyer/seller/warehouse).
4. **`qr_batches` / `return_cases` SELECT**: legacy level/manager rules. Gate them with `qr.batch.manage` /
   `inventory.return.*`.
5. **Ordering availability**: `supply_chain.order.create` reads raw `product_inventory` rows inside the tenant rule. Serve
   availability from a server route or definer RPC that returns only `quantity_available` for the chosen seller, then drop the
   exception.
6. **Module assistant**: `hr.ai.use` (legacy `() => true`) gates the whole assistant. Finance and Customer & Growth tools
   still read with the service client without per-tool checks.
7. **`v_incoming_stock`** is `security_invoker` over `v_incoming_stock_detail`, which Phase 0B made server-only, so incoming
   stock fails for browser callers. Move it to a server route on `inventory.stock.view`.
8. Legacy role-level rules remain in `supplyChainNav.ts` (Organizations L30, Distributor Order L40, Inventory Settings L10)
   and `canOpenOrderEditor` (`view-order` L40). They are ANDed with S&A, so they never broaden access, but a granted level-50
   person can still be refused.
9. Compatibility roles are not refreshed for `inventory.stock.view`. Before enforcing it where legacy authorization is still
   writable, refresh them, or legacy-only holders lose the Inventory page.

10. **`can_access_org()` / `is_hq_admin()` role-level shortcut (platform-wide)**: `is_hq_admin()` is `role_level <= 10`
    with no organization check, and `can_access_org()` starts with it. On staging 5 `MANUFACTURER_USER` accounts and 1
    `CONSUMER` hold the HQ role (level 10). Inventory no longer uses either function for reads (20261107100000); the
    hundreds of other policies that do need their own review before the functions themselves change.
11. **`product_variants.base_cost`** (HQ unit cost) is readable by every authenticated account through
    `variants_read_active`. It is catalog data read by ~19 application files; protecting it needs a masked catalog view or a
    server route, not a column revoke. The Stock Movement Report no longer requests it.

## 5. Tests

* `supabase/tests/security/sa_inventory_stock_view/run.sh`: real S&A migrations on a throwaway PG17, real staging policies
  and view definitions, a negative control that reproduces the leak, the migration applied twice, then Scenarios 1–7 against
  RLS and the views (including revocation, expiry, Root, service role and legacy mode).
* `app/src/modules/supply-chain/supply-chain-access.test.tsx`: navigation, landing and in-app guard (Scenarios 1–6).
* `app/src/lib/security-access/inventory-stock.test.tsx`: TS ↔ SQL lock-step.
* `supabase/tests/security/sa_stock_movement_access/run.sh`: staging schema + S&A configuration replica
  (`build_replica.sh`), synthetic two-company fixtures, negative control reproducing the 403 and the leaks, 20261107100000
  applied twice, S&A-mode and legacy-mode matrices (rows, masked fields, direct table reads, filters/pagination/totals,
  workflow readers, service-role insert).
* `app/src/lib/inventory/stock-movement-access.test.ts`: SQL lock-step + no app code selects a revoked column from the table.
* `app/src/lib/server/module-assistant/tools-supply-chain.access.test.tsx`: assistant tool gate.
* `app/src/components/layout/Sidebar.access.test.tsx`: sidebar entry.

## 6. Stock movements (20261107100000, unapplied)

Root cause of the Stock Movement Report 403: Phase 0B made `vw_stock_movements_ordered` server-only. The earlier draft fix
(20261029100000, security_invoker + grant) is now a no-op because it kept the legacy movement rule and the cost exposure.

| Path | Rows | unit_cost / total_cost | quantity_before / after |
|---|---|---|---|
| `stock_movements` (PostgREST) | `stock_movements_inventory_read`: from/to in `sa_stock_movement_scope()` | **column revoked** (42501) | **column revoked** (42501) |
| `vw_stock_movements_ordered`, `v_stock_movements_display` (owner-run, security_barrier) | same rule | HQ-side callers only, else NULL | HQ-side, or every org on the row in scope; else NULL |
| service role / no API request | unfiltered | yes | yes |

`sa_stock_movement_scope()`: S&A mode = `sa_inventory_stock_scope()` (inventory.stock.view, inventory.report.view or a stock
workflow permission; memberships + scopes, delegation, Root Access; HQ/WH organizations removed for partner accounts).
Legacy mode = previous staff/partner gate on own organization + descendants. "HQ-side" = active `INTERNAL_EMPLOYEE` of an
HQ or WH organization, or Root Access. `sa_inventory_stock_row_visible()` (product_inventory + 4 stock views) no longer
uses `can_access_org()` / `is_hq_admin()`; the ordering exception uses `sa_inventory_tenant_visible(org, ancestors)`, which
never gives a partner an HQ/WH row.
