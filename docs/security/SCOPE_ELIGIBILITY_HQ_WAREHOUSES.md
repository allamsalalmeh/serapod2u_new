# Group Policy scope eligibility (HQ → HQ + its own warehouses)

Branch `issues-fixing-oct2`. Code is in the working tree; migration `20261011100000_sa_scope_eligibility_for_grants.sql` is **not applied**.

## Confirmed behaviour before this change
- `organization` scope: `sa_scope_matches` compares the scope's organization with the resource organization **and every ancestor** (`parent_org_id` chain, depth ≤ 10). An HQ organization scope therefore covers a warehouse **dynamically** (parent chain, not a copied list): a warehouse attached later is covered, one moved to another HQ stops being covered.
- The same chain also reaches **every other descendant** (Distributor, Shop, Manufacturer) whenever a route supplies that partner as the resource organization. It is not a warehouse-only rule.
- `warehouse` scope matches only `context.warehouse_id`; with no warehouse in the resource it reports missing context and denies, so it never authorizes org-wide operations.
- Warehouse context exists only on a minority of enforcement points (12 permissions: stock-count verify/post, transfers, adjustments, opening balance, returns, warehouse receipt/shipment). Everything else is decided on the actor's organization, so a warehouse-only scope cannot match it (fails closed).
- Pickers disagreed: Add User offered scope definitions of the whole subtree (2 levels, all org types) with no authority filter; People & Access offered only scopes whose organization equals the membership organization (so no warehouses for an HQ person); Governance/My requests offered either. Grant-time server checks only required "inside the membership subtree" (+ actor authority via the unapplied 20261009 trigger).
- TS fallback evaluator `policy.ts` (used only before the Final Wave migration exists) compares organization scopes by equality, not ancestry. Not changed; irrelevant once the database evaluator exists.

## Implemented
- `lib/security-access/scope-eligibility.ts` (client-safe, shared): HQ recipient → HQ + active `WH` children (`parent_org_id` = HQ) only; WH recipient → itself; others → itself and beneath (existing hierarchy). One choice per organization (canonical `warehouse` scope; a legacy `organization` definition of a warehouse is only a fallback and is never shown beside it). Labels: "Serapod HQ — HQ and all its warehouses", "Balakong — this warehouse only". Warehouse-support classification per policy (full / partial / none).
- `lib/security-access/scope-grant.ts` (server): builds the same choices from real data, filters by the actor's `security.role.assign` authority per organization, and `validateScopeGrant` (eligibility, policy compatibility, authority). Used by Add User (`createUserWithAuth`), `POST /assignments`, `POST /access-requests` (no authority check for the requester), and the pickers' read model.
- `GET /api/security-access/scope-choices` (grant / request purposes); `me/request-options` now returns the same choices.
- UI: Add User selector, People & Access grant form, Governance request form, My access requests. Short coverage label visible; explanations in the ⓘ popover; a single choice is named but never preselected; a pending scope is cleared when it is no longer offered; the review lists scope + coverage.
- Policies no warehouse can limit are not offered a warehouse scope (explained); partly limited policies show "covers N of M permissions" (nothing removed from the policy).
- Migration (unapplied): `sa_scope_eligible_for_membership`, a `BEFORE INSERT` guard on `sa_assignment_scopes` for `manual` / `access_request` grants, and read-only `sa_scope_eligibility_report()`.

## Effect on existing grants (before rollout)
None. No assignment, scope definition or link is rewritten or re-evaluated; the evaluator is untouched. Run `select * from public.sa_scope_eligibility_report();` (service role) first: rows are existing administrator grants a new grant could no longer repeat (e.g. an HQ person holding a Distributor scope). They keep working; re-granting one is refused with `sa_scope_not_eligible`.

## Business decisions still open
1. An HQ organization scope reaches partner organizations beneath the HQ whenever a route supplies the partner as the resource organization (also what lets HQ admins manage distributor/shop users). Approved text says it must not grant "unrelated partner organizations"; narrowing it to HQ + warehouses would change existing behaviour and break HQ administration of partners, so it was deliberately not done. Decide whether to introduce a separate "HQ only + warehouses" scope kind.
2. Partner recipients keep "own organization and beneath" (e.g. shops under a distributor) – today's evaluator hierarchy. Confirm that is wanted.
3. Warehouse-capable permission list is derived from current enforcement points; permissions not on it are never granted by a warehouse scope. Wire more routes with warehouse context if wanted.
4. A warehouse without any `warehouse`/`organization` scope definition has no "this warehouse only" choice (the HQ scope still covers it). Definitions are created by lifecycle sync; the picker never creates them.
5. Non-structural typed scopes (department, territory, …) are no longer shown in these pickers and keep their database rules on the API.
