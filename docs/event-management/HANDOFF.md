# Event Management — Handoff

## Read these first (in order)

1. `README.md` — status, branch/base, scope.
2. `ASSESSMENT.md` — verified evidence, reusable pieces, risks, Ellbow assets, migration naming.
3. `IMPLEMENTATION_PLAN.md` — folder/route layout, data model, permissions, API, phases, tests.
4. This file — decisions, confirmed vs pending vs proposed, next step, prompt.

The core business decisions are now approved (see "Confirmed this round"). Initial implementation
may start once separately authorized, gated by the existing Marketing parent access
(`marketing.module.view`); the `event.*` permissions / Full Access extension are deferred to a future
granular-access phase.

---

## Confirmed this round (latest user decisions)

### S&A / parent-access direction (agreed)

- **Initial access uses the existing parent gate.** Event Management sits under Customer & Growth →
  Marketing (below Road Tour), so it reuses the existing Marketing module-entry permission
  `marketing.module.view` (see `app/src/app/marketing/_lib.ts`) via
  `authorizeOperation`/`guardUserOperation` + `organizationResource('marketing_module', orgId)`, for
  navigation, admin pages and APIs, with org isolation. Sidebar visibility alone is insufficient.
- **Gap:** there is no Customer & Growth domain-level parent permission — the domain landing returns
  `canViewCustomerGrowth = true` for all authenticated users.
- **Database enforcement (Strategy B):** the parent permission has no DB equivalent usable inside RLS
  (S&A evaluation is server-side; `sa_readable_organizations` is service-role only). So `event_*`
  tables and RPCs deny direct access to `anon`/`authenticated` (RLS enabled + table grants revoked +
  RPC `PUBLIC` EXECUTE revoked). Admin endpoints verify `marketing.module.view` + org scope and use
  the service-role client with explicit org filtering; public registration is token-scoped. See
  IMPLEMENTATION_PLAN.md §4.
- **Deferred granular-access phase:** `event.*` permissions, their seed migration, and the Customer &
  Growth Full Access extension are deferred. The shared S&A framework (Group Policies, Full Access,
  destination navigation) on `issues-fixing-oct2` is required only for that future phase.
  Preferred sequence: complete/validate S&A → integrate to `staging` → update `event_management` →
  then add `event.*`. Do not merge the branch wholesale, do not create a parallel framework, and do
  not silently extend Full Access.
- Admin functionality must not be activated without authorization.
- Do **not** move the Event Management module into `issues-fixing-oct2`, and do **not** merge, rebase,
  or cherry-pick anything as part of this planning work.

### Registration rules (approved)

- **Mandatory:** name and Malaysian mobile phone. **Optional:** email, cat name, cat breed.
- **No** OTP or SMS verification in this version.
- Normalize to canonical E.164 `+60` using existing helpers (`normalizePhoneE164`).
- Validate Malaysian mobile format, length, and supported prefixes on the server; client validation
  provides immediate feedback only.
- Reuse and inspect existing validation before proposing new logic.
- Do **not** infer the current telco from the prefix.
- Format validation does not establish ownership or active service.
- **One normalized phone per event** (`UNIQUE (event_id, phone_normalized)` on `event_contacts`,
  `phone_normalized` `NOT NULL`).
- **First successful registration source is fixed, including booth:** booth → staff A stays booth;
  staff A → staff B stays staff A.
- Duplicate submissions never overwrite personal details, consent, the original QR source, or staff
  attribution.
- Metrics describe **registrations**, not verified identities.

---

## Technical verification (read-only, not a business decision)

- **Ellbow `brands` row / `logo_url` existence** is a technical verification task, not a question the
  user must answer from memory. Keep the read-only DB check pending while live DB access is
  unavailable. Use the identified Journey Builder assets as the design reference; do not invent
  paths, silently create brand data, or claim live DB findings.

## Previously approved (unchanged)

- Base branch: `origin/staging` @ `9e27404d`; branch `event_management`.
- Place Event Management under **Customer & Growth → Marketing**, directly below **Road Tour**, in
  both the overview card and the top dropdown.
- Group S&A permissions under **Customer & Growth → Event Management** consistently in Policies,
  Group Policies and Migration Modes.
- Sidebar visibility, page access and server/API authorization use consistent permissions + org scope.
- Public QR registration is separate from staff/admin access and must **not** require an admin Group
  Policy.
- Do **not** silently modify existing grants (e.g. `customer-growth-full-access`).
- This round is assessment + documentation only; no implementation.

---

## Proposed (not yet approved — recommendations)

- Folder layout `app/src/modules/event-management/` (not `app/src/features/`).
- **Deferred granular-access phase (not required for initial implementation):** the five proposed
  `event.*` keys — `event.event.view`, `event.event.manage`, `event.registration.view`,
  `event.report.view`, and the separate `event.registration.export` — plus their `sa_permissions`
  seed and `modules.ts` `event` area + `labels.ts` `MODULE_GROUPS` entry. These are recommendations,
  **not** approved grants; registering a permission and granting it are different operations.
- Full Access extension (deferred): `customer-growth-full-access` would require
  `sa_extend_standard_policy(...)` to cover `event.*`; it is **not** auto-extended, and the extension
  is explicit, not silent. Do not silently extend existing Full Access policies without approval.
- Data model (6 tables) and the `event01`–`event03` migration sequence under `supabase/migrations/`
  (naming `YYYYMMDD_eventNN_short_description.sql`).
- QR source of truth: `event_qr_tokens` holds both staff and booth tokens (no `booth_qr_token` column
  on `event_events`).
- Registration date defaults and admin overrides — see IMPLEMENTATION_PLAN.md §3–§5.

## What was implemented (initial phase — done and locally verified)

- **Initial implementation is complete** on `event_management`, gated by the existing Marketing
  parent access `marketing.module.view` (no `event.*` keys). Schema/migrations (event01–event03),
  shared helpers (`app/src/modules/event-management/`), admin pages/APIs
  (`app/src/app/marketing/event-management/…`, `app/src/app/api/event-management/…`), public
  registration (`/event/[token]` + `POST /api/event-management/public/register`), visitors/stats/
  export, and navigation (below Road Tour) are all implemented.
- **Verification completed:**
  - Production build (`next build`) — clean: 518/518 pages, no errors/warnings, all 13 event
    routes present (`/api/event-management/*`, `/event/[token]`, `/marketing/event-management*`).
  - 45 Event Management Vitest tests pass — admin API authorization (no `marketing.module.view` →
    403; cross-org event/contact/token IDs → denied/null; service-role queries assert an explicit
    `organization_id` filter), registration validation, attribution, duplicate, export
    formula-injection, nav, and jsdom component renders of the public form + admin landing view.
  - Real-database tests (isolated disposable Postgres 17, synthetic fixtures): 26 assertions +
    a two-connection concurrency check for same-phone dedupe.
  - Isolated `next start` preview smoke test: public page renders its fallback (200), admin page
    + detail page redirect to `/login` (307), admin API returns 401 without a session, public
    register returns 400 on invalid phone (validation before DB).
  - Remaining limitations: no live Supabase credentials / browser, so no end-to-end authenticated
    admin render or live Ellbow brand/logo check; the 3 pre-existing inventory test failures are
    baseline and unrelated.
- **Migrations are CREATED / NOT APPLIED** — the user must apply `20261007_event01` → `event02` →
  `event03` manually, in order, and record the result in
  `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`.

## Integration into `issues-fixing-oct2` (complete)

- `event_management` was merged **locally** into `issues-fixing-oct2` (merge commit `9129fc09`,
  parent `a19d2e65`). The module is now developed in `/Users/edierwan/serapod2u_dev`.
- Conflict resolution: `CreateOrderView.tsx` keeps the atomic `save_order_with_items` RPC (from
  staging) **and** the QR-buffer refactor (issues-fixing-oct2); `PRODUCTION_MIGRATION_STATUS.md`
  unions both branches' migration entries; the subsequent `EditOrganizationView.tsx` /
  `route-coverage.ts` conflicts from the in-flight work were resolved to the newer
  issues-fixing-oct2 implementations and a union of route-coverage entries.
- Event Management navigation was adapted to the destination-based S&A framework:
  `CUSTOMER_GROWTH_DESTINATIONS['event-management'] = marketingChild()` (module entry
  `marketing.module.view` alone, no `event.*` keys). The `customerGrowthNav` child sits below Road
  Tour and is filtered by the per-user navigation snapshot.
- In-flight S&A/notification/HR/finance work in `/Users/edierwan/serapod2u_dev` was preserved via a
  `git stash` checkpoint (`stash@{0}`) and restored afterwards; it remains uncommitted.

## What remains blocked / deferred

- The `event.*` granular-access phase (permissions, seed migration, Full Access extension) remains
  deferred; it needs the shared S&A framework finalized on `issues-fixing-oct2` (complete/validate
  S&A → integrate to staging).
- Live Ellbow `brands` row / `logo_url` verification remains a read-only technical check (no live DB
  access was available); the verified Journey Builder assets were reused and no brand data was
  created.
- The three Event Management migrations (`20261007_event01`/`event02`/`event03`) are **CREATED /
  NOT APPLIED** — apply them manually, in order, then record the result in
  `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`.

## Update these documents as implementation progresses

- Move a decision from "pending"/"proposed" to "confirmed" in this file when the user approves it.
- Mark ASSESSMENT.md findings that change (e.g. once `nav-access.ts` is available on the branch).
- Tick off phases and record acceptance results in IMPLEMENTATION_PLAN.md.
- Update `README.md` "Status" when development begins.
- Update `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md` in the same commit as each migration.

---

## Ready-to-copy prompt for the next session

```
You are working on the `event_management` branch of Serapod2U (base origin/staging @ 9e27404d,
currently 2 documentation-only commits ahead of staging).
First read docs/event-management/README.md, ASSESSMENT.md, IMPLEMENTATION_PLAN.md, and HANDOFF.md.
Confirmed decisions are recorded in HANDOFF.md (name + Malaysian mobile phone mandatory, no OTP/SMS,
email/cat name/cat breed optional, E.164 +60 normalization, one normalized phone per event, first
successful registration source fixed including booth, duplicates never overwrite).
Initial access reuses the existing Marketing parent gate `marketing.module.view` (see
app/src/app/marketing/_lib.ts) via authorizeOperation/guardUserOperation + organizationResource with
org isolation — do not introduce event.* permissions yet. Deny direct event_* table/RPC access to
anon/authenticated (RLS enabled + revoke table grants + revoke RPC PUBLIC EXECUTE, grant to
service_role only); route all access through server endpoints using the service-role client with
explicit organization filtering and event/contact/token ownership checks. The event.* permissions,
their seed migration, and the Full Access extension are deferred to a future granular-access phase
that depends on the shared S&A framework on issues-fixing-oct2 (complete + validate S&A -> integrate
to staging -> update event_management from staging). Do not create a parallel framework or merge that
branch.
Implement only the independently-authorized work (schema planning + migration preparation + UI +
admin pages/APIs gated by the parent permission). Use the conventions in those docs:
app/src/modules/event-management/, server-side QR token resolution, E.164 phone normalization via
app/src/utils/phone.ts, and the single atomic registration RPC. Enforce
NOT NULL name/phone and UNIQUE(event_id, phone_normalized) on event_contacts plus
UNIQUE(event_id, contact_id) on event_registrations. Public QR registration stays outside S&A
(service-role token resolution, no Group Policy). Manual migrations tracked in
supabase/migrations/PRODUCTION_MIGRATION_STATUS.md (I run them manually). Do not push, merge, rebase,
cherry-pick, deploy, or run migrations yourself. Write Vitest tests colocated with source (add the
required .gitignore un-ignore rules), and add real database tests for the constraints and the atomic
RPC behavior — mocked route tests alone do not prove those guarantees. Show me the migration files
and the diff before I apply anything.
```
