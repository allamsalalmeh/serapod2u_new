# Warehouse Manager — Full Access and warehouse-scoped grants

Migration `supabase/migrations/20261109100000_sa_warehouse_manager_full_access.sql` has **not been applied** anywhere.
Test harness: `supabase/tests/security/sa_warehouse_manager/run.sh <disposable sa_prof_test* database>`. It runs the real
S&A migrations on stand-in tables, a negative control before the migration, the migration twice, the unchanged
inventory suite as a regression check, and the Warehouse Manager scenarios.

## Confirmed root cause (staging, read-only, 2026-10-12)

`orderapp@dev.com` is an HQ account (Serapod Technology Sdn Bhd, legacy GUEST level 50). It holds an active Warehouse
Manager grant whose only scope is the `warehouse` scope "Serapod Warehouse Balakong".

| # | Cause | Effect |
|---|-------|--------|
| 1 | The Warehouse Manager policy held only 9 keys (stock count + transfer). Wave 1 copied `inventory.%` once, and every later Inventory key and the product catalogue were never added. The policy had no `sa_standard_policy_coverage` row, so the controlled update process skipped it. | No View Inventory, Add Stock, Movement Reports, settings, returns or products. |
| 2 | Navigation and page guards ask the engine on the account's **own organization** (HQ). A `warehouse` scope matched only a context that named `warehouse_id`, so every answer was `MISSING_CONTEXT` → DENY. | The Supply Chain entry and every child were hidden: only Dashboard and HR remained. |
| 3 | The engine also refused a context whose organization **is** the warehouse when it did not repeat `warehouse_id`. All RLS write gates (`sa_api_require_any_org`) and organization-column contexts send exactly that. | Even inside Balakong, warehouse-scoped writes were refused. |
| 4 | `sa_readable_organizations` (list scope for stock, movements and reports) followed `organization` scopes only. | A warehouse-scoped grant read no rows at all. |

Not the cause: caching. `/api/security-access/me/navigation` is `no-store` and decided on every request. Page guards
decide on every request. The client revalidates on focus (after one minute) and on in-app access changes. Revoke,
expiry and restore are read fresh by the next request.

## What changed

**Database (migration 20261109100000)**
- `sa_scope_matches`: a `warehouse` scope also matches a context **without** `warehouse_id` whose `organization_id` is exactly that warehouse. The parent HQ, sibling warehouses and descendants still answer `MISSING_CONTEXT`. A context that names `warehouse_id` is decided exactly as before.
- `sa_readable_organizations`: a `warehouse` scope reaches exactly its warehouse. Organization scopes, Root Access and delegation are unchanged.
- Warehouse Manager joins the controlled update process (coverage row = current live set). `sa_extend_standard_policy` then adds the missing keys: SoD-checked, audited once as `access_profile.standard_extended`, plus `assignment.profile_changed` per active holder. Existing grants get the permissions at once: no re-grant, no scope change, no history rewritten.

**Warehouse Manager after the migration (19 keys, same policy row):**

| Area | Keys |
|------|------|
| Products | `product.catalog.view`, `product.catalog.manage` |
| Inventory | `inventory.stock.view`, `inventory.stock_config.manage`, `inventory.opening_balance.manage`, `inventory.adjustment.post`, `inventory.report.view`, `inventory.stock_count.view/create/verify/post`, `inventory.transfer.view/request/approve/dispatch/receive/cancel` |
| Quality & Returns | `inventory.return.request`, `inventory.return.manage` |

Not included: `supply_chain.*` (Order Management); `qr.*`, `manufacturing.*`, `warehouse.receipt.post` and `warehouse.shipment.manage` (QR Tracking); `platform.organization.manage` (Organizations). No new permission key was introduced.

**Application**
- `lib/security-access/warehouse-reach.ts` lists the functions whose pages, APIs and data all decide per warehouse (`WAREHOUSE_REACH_PERMISSIONS`). `lib/server/warehouse-reach.ts` reads the warehouses named by the person's live grants and provides `guardUserOperationInReach`.
- `lib/server/nav-access.ts` (`decide`, shared by the snapshot and every page guard): a reach permission denied on the own organization is asked again on each granted warehouse. The engine decides each answer. Page guards record those decisions, and the snapshot is explain-only.
- `/api/movements`, `/api/inventory/stock-count/verification/preflight` and `/api/inventory/stock-count/drafts/posting-status` use `guardUserOperationInReach`. Their rows are already limited by RLS (`sa_stock_movement_scope`, `stock_count_sessions` gate, per-session warehouse checks).
- `supplyChainNav`: when the S&A answer is present, role-level limits are not applied a second time, because the answer already carries each permission's legacy level rule in legacy modes. Organization-type rules stay.
- `policy.ts` (the TypeScript fallback evaluator) mirrors the new `warehouse` match.

## Scope conflicts (reported, not widened)

A Warehouse Manager scoped **only to Balakong** gets these functions in Balakong:

| Function | Warehouse-only grant | Why |
|----------|----------------------|-----|
| View Inventory, Add Stock, Stock Adjustment, Stock Transfer, Movement Reports | **Works**, Balakong only | RPCs carry the warehouse; RLS and list scope follow the warehouse |
| Product List, Master Data, Product Catalog | **Not available** | Product master data is HQ-owned. Its RLS gates and RPCs decide on the company (`sa_actor_company_id()`), and a warehouse scope cannot match HQ. |
| Inventory Settings | **Not available** | Stock configuration and opening-balance APIs decide on the organization (`getStockConfigAdminContext`) |
| Return Product, Return Settings, Return Reporting | **Not available** | The returns server decides `inventory.return.*` on the organization; return reasons, conditions and settings are organization-level |

All 12 functions in one grant need a scope that covers the HQ organization. An organization scope on HQ **also reaches every warehouse under HQ** (Balakong, Alma, …), so that is an administrator's decision, not something this change makes. Options:
1. Grant Warehouse Manager on the HQ scope (all HQ warehouses).
2. Keep Warehouse Manager on Balakong, and grant a separate policy for products, settings and returns on the HQ scope. No such narrow standard policy exists yet, so it would be a Custom Policy.
3. Make the returns and stock-configuration servers warehouse-aware (return cases carry `return_warehouse_id`). This is a follow-up.

## Remaining risks / follow-ups
- `stock_transfers_manage_hq` (FOR ALL) still lets any HQ account read every transfer, and `return_cases_select` follows the returns manager rule. Both predate this change, are listed in `SUPPLY_CHAIN_ACCESS_COVERAGE.md`, and are not widened here.
- The Add Stock and Stock Transfer warehouse pickers may list warehouses outside the grant. The RPC refuses them.
- `inventory.opening_balance.manage` is in `WAREHOUSE_SCOPED_PERMISSIONS` (its RPCs carry the warehouse), but its settings APIs decide on the organization. It is therefore not in `WAREHOUSE_REACH_PERMISSIONS`.

## Manual test (after applying the migration on staging)
1. Sign in as `orderapp@dev.com`. Supply Chain appears with Inventory → View Inventory, Add Stock, Stock Adjustment, Stock Transfer and Movement Reports. Only Balakong rows are shown.
2. Direct URLs `/supply-chain/products`, `/supply-chain/orders` and `/supply-chain/qr-batches` show "no access".
3. Security & Access → orderapp → revoke Warehouse Manager. After a refresh (or tab focus after one minute), Supply Chain disappears. Restore it and it comes back.
4. To see all 12 functions, grant on the HQ scope instead and accept that it covers every HQ warehouse. Products, Inventory and Quality & Returns then all appear.
