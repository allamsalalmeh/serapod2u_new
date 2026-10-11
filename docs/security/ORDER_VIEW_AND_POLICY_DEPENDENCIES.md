# View Orders and Group Policy supporting reads

Status: implemented on `issues-fixing-oct2`. Migration `20261101100000_sa_order_view_policy_dependencies.sql` is **not applied** to any environment.

## 1. Confirmed root cause (orderapp@dev.com: HQ, GUEST level 50, Order Approver active)

| Path | Question asked | Result for orderapp |
|---|---|---|
| Approve button (OrdersView) | S&A `supply_chain.order.approve` | ALLOW (Order Approver) |
| `orders_approve()` RPC | `sa_require_operation('supply_chain.order.approve', approval org)` | ALLOW |
| Order Details (`view-order`, `track-order`) client guard | Orders destination (S&A) **AND** `canOpenOrderEditor(roleLevel)` = role level ≤ 40 | **DENY** → "Unauthorized" |
| `GET /api/orders/[orderId]/access` | `orders_select` RLS only (party organization) | ALLOW |

The page guard and the approval path used different authorization rules. No S&A permission meant "view orders":
Order Approver held exactly `supply_chain.order.approve`, so reading fell back to the legacy role-level rule, which a
level-50 account cannot pass whatever it is granted.

## 2. Decision: a dedicated `supply_chain.order.view`

No existing permission fit (`order.create/approve/cancel` are operations; `document.*` are document operations). Added:

* `supply_chain.order.view` — "View orders in scope: the order list and order details". Ordinary sensitivity.
* Compatibility rule: role level ≤ 40 (the old Order Details rule); no legacy permission, so it never widens.
* Mode: `NEW_ENFORCED` where `supply_chain.order.approve` is already S&A-authoritative (staging), otherwise `SHADOW`.
* Existing compatibility roles at level ≤ 40 (never GUEST) receive it, so no level-40 account loses Order Details when the
  key is enforced.

Read scope: the S&A data scope of the grant, evaluated on the order's party organizations — the approval organization first
(H2M → buyer, otherwise seller: exactly what `orders_approve()` authorizes on), then buyer, seller, warehouse. View reach
therefore always includes approval reach (proved for every organization in the SQL harness). Approved orders stay visible
(no status filter): the approval workflow itself shows approved orders, and no workflow rule restricted that before.

## 3. Policy changes

| Policy | Before | After |
|---|---|---|
| Order Approver | `order.approve` | `order.approve`, `order.view` |
| Order Creator (20261028100000) | `order.create` | `order.create`, `order.view` |
| Supply Chain Full Access | 30 keys | + `order.view` (via `sa_extend_standard_policy`) |

Not added to any policy: create, cancel, delete, inventory, QR. The maker/checker SoD rule and `orders_approve()` checks are
unchanged. Existing assignments pick the read up through the canonical mapping (no new or duplicate grant; every holder
gets an `assignment.profile_changed` audit row). Custom policies are never changed: a custom policy with only
`order.approve` lists orders but does not open them until an administrator adds `order.view`.

## 4. Dependency convention

`Group Policy → explicit permission set → effective access`. No second engine.

* `public.sa_permission_dependencies(permission_key, requires_key, reason)`: declared supporting reads (seeded:
  order approve/create/cancel → order.view). API roles cannot read it; no decision consults it.
* `public.sa_standard_policy_dependency_gaps()`: standard policies whose operations lack a declared supporting read. The
  migration fails if an order policy has a gap and prints any other gap as a NOTICE.
* App mirror `lib/security-access/policy-dependencies.ts` (lock-step test `order-view.test.ts`). The Group Policies panel
  marks a read as "included to support …" and, for standard non-Full-Access policies, lists "Does not include: …" for the
  same functional area — both derived from the policy's real mapping and the catalogue.
* A new standard policy declares: primary operations, supporting reads (explicit in its mapping), `applicable_org_types`,
  scope rules, SoD. Adding a dependency to an existing policy is a reviewed migration like section 5 of 20261101100000.

## 5. Enforcement path

| Layer | Decision |
|---|---|
| Sidebar / landing / top nav | `supply-chain/orders` = any order or document permission incl. `order.view` |
| Server page guard (`/supply-chain/view-order/...`) | `supply-chain/view-order` = `order.view` |
| Client guard (`canAccessSupplyChainView`) | S&A answer for `supply-chain/view-order`; legacy level 40 only when no S&A answer is supplied |
| `GET /api/orders/[orderId]/access` | `orders_select` RLS, manufacturer seller rule, then S&A `order.view` on the party orgs (503 when S&A is unavailable) |
| Approve | unchanged (`order.approve`, RPC guard, maker/checker) |
| Database `orders_select` | **unchanged** (tenant/party rule) — see §6 |

Revocation: the evaluator reads active assignments per request, so revoking Order Approver removes both its approval and
its contributed view on the next request; other grants are unaffected (harness Test 4).

## 6. Remaining limitations / follow-ups

1. **`orders_select` is still tenant/party only.** Any member of a buyer/seller/warehouse organization (and HQ level ≤ 20)
   can read those order rows straight from PostgREST without `order.view`. The Order Details screen and its access route
   now decide through S&A, but the table does not. Gating it needs the complete reader list (QR batches, warehouse
   receive/ship, documents, finance, messaging/serapp, reports) like `sa_inventory_stock_read_permissions`; do it as a
   separate reviewed migration. `order_items` follow the same rule.
2. OrdersView's Copy / Cancel / Delete buttons still use legacy role levels (1/10/30/40). They grant nothing beyond their
   own RPC checks, but they are not S&A-driven.
3. `SupplyChainTopNav` "Distributor Order" (level 40) and `canOpenOrderEditor` for the editor remain legacy where
   `order.create` is not enforced (unchanged).

## 7. Supply Chain policy dependency audit

| Policy | Primary permission(s) | Supporting read needed | Existing coverage | Gap | Recommendation | Security impact |
|---|---|---|---|---|---|---|
| Order Approver | `order.approve` | `order.view` | none (legacy L40) | **Yes** | **Fixed here** | Closes a functional gap; view limited to approval scope |
| Order Creator | `order.create` | `order.view`; stock availability; catalogue | availability via `product_inventory` exception (20261031100000); products are reference data | `order.view` | **Fixed here** | Own scope only |
| Catalogue User | `product.catalog.view` | — (is the read) | yes | no | none | — |
| Stock Adjustment Administrator | `manufacturing.adjustment.administer` | adjustment list + manufacturer context | `stock_adjustments` SELECT tenant; page guard accepts `.administer` | no confirmed gap | verify in BAT with a level-50 holder | — |
| QR Batch Operator | `qr.batch.manage` | read `qr_batches` | `qr_batches` SELECT = legacy `sa_actor_is_staff(40)` | **Yes (level > 40)** | gate SELECT with `qr.batch.manage` scope (coverage doc follow-up 4) | functional only; no over-exposure |
| Warehouse Manager / Operator | `inventory.stock_count.*`, `inventory.transfer.*` | stock balances; transfer/movement lists | stock balances via the stock read rule; `stock_transfers` / `stock_movements` SELECT legacy | partial | split `stock_transfers_manage_hq` FOR ALL; move `stock_movements` to the stock rule | `stock_transfers_manage_hq` over-exposes (any HQ reads all transfers) |
| Manufacturing Full Access — Manufacturer | `manufacturing.adjustment.manage`, `.production.manage`, `.scan.reverse` | orders placed with it; its QR batches | orders via seller party; `qr_batches` legacy L40 | possible for MFG staff > level 40 | same `qr_batches` follow-up | functional only |
| Supply Chain Full Access | all Supply Chain keys | — | now includes `order.view` and `inventory.stock.view` | no | none | — |
| Inventory Viewer | `inventory.stock.view` | — (is the read) | yes (20261031100000, unapplied) | no | none | — |

No policy named "Manufacturing Access" exists in the migrations; the manufacturer policy above is the closest match.

## 8. Verification

* SQL: `supabase/tests/security/sa_order_view/run.sh <sa_prof_test* DB>` — real S&A migrations on stand-ins, negative
  control, migration applied twice, Tests 1–5 + definition/audit/compatibility/custom-policy checks.
* App: `order-view.test.ts`, `supply-chain-access.test.tsx` (Scenario 3), `route-coverage.test.ts`, `coverage-audit.test.ts`,
  `group-policies.test.ts`.
