# Event Management — Implementation Plan

Status: **implemented (Phase 1–5), locally verified, and integrated into `issues-fixing-oct2`**
(now developed in `/Users/edierwan/serapod2u_dev`). The source `event_management` branch was
merged locally (merge commit `9129fc09`) and Event Management navigation adapted to the
destination-based S&A navigation framework. Migrations are **CREATED / NOT APPLIED** (awaiting
the user's manual migration step). The `event.*` granular-access phase remains **deferred**.

**Access model:** initial Event Management access reuses the existing **Marketing parent gate**
`marketing.module.view` (see `app/src/app/marketing/_lib.ts`) via `authorizeOperation`/
`guardUserOperation` + `organizationResource('marketing_module', orgId)`, for navigation, admin pages
and APIs, with org isolation. The `event.*` permissions, their seed migration, and the Full Access
extension are **deferred** to a future granular-access phase, which depends on the shared S&A
framework on `issues-fixing-oct2` (Group Policies, Full Access, destination navigation) brought in
via the agreed sequence (complete/validate S&A → integrate to staging → update `event_management`).
Do not create a parallel S&A/navigation framework and do not move this module into
`issues-fixing-oct2`. Admin functionality must not be activated without authorization.

---

## 1. Folder & route organization

### Recommended: `app/src/modules/event-management/` (NOT `app/src/features/`)
The repo's established convention is `app/src/modules/<module>/` with
`components/`, `lib/`, `types/`, and a `<module>Nav.ts` (see `app/src/modules/roadtour/`,
`app/src/modules/marketing/`, `app/src/modules/customer-growth/`). A new `features/` top-level
folder would introduce a second convention, so we avoid it.

```
app/src/modules/event-management/
  eventManagementNav.ts          # nav ids, view→path maps, breadcrumbs (mirrors marketingNav/roadtourNav)
  components/
    EventManagementLandingView.tsx
    EventOverviewView.tsx
    EventsListView.tsx
    EventVisitorsView.tsx
    EventStaffQrView.tsx
    EventSettingsView.tsx
    ... (admin screens)
  lib/
    events.ts                    # server-side event CRUD + org scope
    staff-qr.ts                  # QR token create/resolve/revoke (server)
    registrations.ts             # public + admin registration read/write
    attribution.ts               # first successful registration source (incl. booth), booth-vs-staff rules
    duplicate.ts                 # phone/identity duplicate policy
    export.ts                    # CSV/Excel export with permission gate
  validation/
    registration.ts              # zod schemas for the public form + admin forms
  types/
    event.ts                     # Event, EventStaff, QrToken, Registration, Contact
```

### Thin route/page files (in existing routing directories)
```
app/src/app/marketing/event-management/
  page.tsx + _lib.ts             # admin shell → EventManagementLandingView
app/src/app/marketing/event-management/[eventId]/
  page.tsx + _lib.ts             # per-event shell (Overview/Visitors/Staff & QR/Settings)
app/src/app/api/event-management/
  events/route.ts                # list/create events (admin)
  events/[eventId]/route.ts      # get/update event
  events/[eventId]/staff/route.ts
  events/[eventId]/qr/route.ts   # create/list staff QRs + booth QR
  events/[eventId]/qr/[token]/image/route.ts   # render QR (qrcode)
  events/[eventId]/registrations/route.ts      # list/filter/export (admin)
  events/[eventId]/stats/route.ts              # counts + staff comparison
  public/register/route.ts       # POST anonymous registration (rate-limited)
  public/event/[token]/route.ts  # GET resolved event/form config from token (no PII in URL)
```

Public pages (separate from admin, Ellbow branded):
```
app/src/app/event/[token]/page.tsx   # public form + confirmation (Ellbow branding)
```

### Why this split
- Admin vs public are in different route trees, so middleware/RLS/permissions never overlap.
- Public pages reuse the Ellbow asset roots from `app/src/components/journey/petfood/` rather than
  copying them; admin pages reuse the existing orange-themed module shells.
- Server-only logic lives in `lib/` (as RoadTour does); validation is colocated in the module.

---

## 2. Page-by-page scope

| Screen | Route | Scope |
|---|---|---|
| Event Management (module) | `/marketing/event-management` | Tabs: Overview / Events / Settings |
| Overview | tab | KPI cards: total registrations, active events, staff leaderboard, new/returning |
| Events | tab | List (draft/active/ended/cancelled), create/edit, per-event deep link |
| Settings | tab | Form field config (required vs optional), consent text, brand (Ellbow) |
| Event Overview | `/…/event-management/[eventId]` | Event meta, dates, status, registration count |
| Visitors | tab | Attendee list, search/filter, export |
| Staff & QR | tab | Assign staff, generate one QR per staff, general booth QR, per-staff counts |
| Settings | tab | Event dates, form config override, cancel/end event |
| Public form | `/event/[token]` | Ellbow-branded form → confirmation (no login) |

## 3. Proposed data model

New tables (all `public.*`, UUID PKs, `created_at/updated_at`, org-scoped). Follow the
`roadtour_*` naming and RLS patterns. Proposed, not final:

```
event_events
  id, organization_id → organizations, brand_id → brands (nullable),
  name, slug, status (draft|active|ended|cancelled),
  starts_at timestamptz, ends_at timestamptz,
  timezone text default 'Asia/Kuala_Lumpur',
  registration_opens_at timestamptz NULL, registration_closes_at timestamptz NULL,
      # NULL falls back to starts_at/ends_at (see §5) — never "always open"
  form_config jsonb,           # required/optional field flags + consent text
  created_by → users
  # NO booth_qr_token column here — booth QRs live in event_qr_tokens (single source of truth)

event_staff
  id, event_id → event_events, user_id → users,           # participating staff
  unique(event_id, user_id)

event_qr_tokens                     # single source of truth for BOTH staff and booth tokens
  id, event_id → event_events, staff_user_id → users (NOT NULL for staff; NULL for booth),
  token text unique (encode(gen_random_bytes(32),'base64url')),
  kind text CHECK (kind IN ('staff','booth')),
  status (active|revoked|expired), created_at
  CHECK ((kind = 'staff' AND staff_user_id IS NOT NULL) OR (kind = 'booth' AND staff_user_id IS NULL))
  # staff_user_id must reference an event_staff row for this event (FK or trigger)
  # one ACTIVE staff QR per (event, staff):
  #   UNIQUE (event_id, staff_user_id) WHERE kind = 'staff' AND status = 'active'
  # one ACTIVE booth QR per event:
  #   UNIQUE (event_id) WHERE kind = 'booth' AND status = 'active'

event_contacts                     # event-specific contact entity (anonymous-safe)
  id, event_id, name text NOT NULL, phone_normalized text NOT NULL, email_normalized text,
  cat_name, cat_breed text (incl. 'Tidak pasti'), current_cat_food text (optional),
  user_id → users (nullable, explicit identity link only, never created/implied)
  # name + phone mandatory; email/cat_name/cat_breed/current_cat_food optional
  # phone_normalized: canonical E.164 '+60…' via normalizePhoneE164; CHECK enforces NOT NULL + '+60'
  #   shape; full Malaysian mobile format/length/prefix validation runs server-side in the RPC/route
  # UNIQUE (event_id, phone_normalized) — one normalized phone per event
  # NO password/auth; personal data lives here, not in QR URLs

event_registrations
  id, event_id, contact_id → event_contacts, qr_token_id → event_qr_tokens,
  attributed_staff_user_id → users (NULL = booth; the FIRST successful source, fixed),
  submitted_at timestamptz, ip text
  # UNIQUE (event_id, contact_id) — one registration per contact per event
  # composite FKs keep contact/token in the same event/org:
  #   FOREIGN KEY (event_id, contact_id) REFERENCES event_contacts (event_id, id)
  #   FOREIGN KEY (event_id, qr_token_id) REFERENCES event_qr_tokens (event_id, id)
  # attribution: ONE authoritative field attributed_staff_user_id (NULL = booth). Staff-vs-booth kind
  #   is derived from qr_token_id → event_qr_tokens.kind — never stored twice, so fields cannot disagree.
  #   qr_token_id is the original token and is historically stable: tokens are soft-revoked (status),
  #   never hard-deleted, so the FK stays valid when tokens are revoked or staff are reassigned.
  # no phone_normalized column here — dedupe is enforced on event_contacts

event_consents                       # registration consent vs marketing consent separated
  id, registration_id, kind (registration|marketing), granted boolean, recorded_at
```

**Storage rules:**
- Dates stored `timestamptz` (UTC); "Asia/Kuala_Lumpur" is a display/config concern. Event date
  boundaries are evaluated in the event's `timezone` (mirrors `roadtour_runs` + `20260411_fix_roadtour_timezone.sql`).
- `phone_normalized`/`email_normalized` reuse `normalizePhoneE164` / `identity_normalize_email`.
  `phone_normalized` lives **only** on `event_contacts` (single source of truth) and is **`NOT NULL`**
  (phone is mandatory this version); the dedupe constraint is enforced there, not on `event_registrations`.
- `event_contacts.name` is **`NOT NULL`** (name is mandatory); `email_normalized`, `cat_name`,
  `cat_breed`, `current_cat_food` are optional.
- `event_registrations` enforces **`UNIQUE (event_id, contact_id)`** (one registration per contact per
  event); `event_contacts` enforces **`UNIQUE (event_id, phone_normalized)`** (one normalized phone per
  event). Together they make concurrent submissions converge to one contact + one registration.
- `registration_opens_at`/`registration_closes_at` are optional overrides; `NULL` falls back to the
  event's `starts_at`/`ends_at` (never "always open"). See §5.
- QR tokens contain no personal data and resolve event+staff **server-side** only.

### Authorization: parent gate now, `event.*` deferred

**Initial access (this phase)** uses the existing Marketing parent gate — no new permissions:
- Every Event Management admin page/API is gated by the same parent check as Marketing:
  `authorizeOperation({ actorId, permission: 'marketing.module.view', resource: organizationResource('marketing_module', organizationId), legacy: () => orgType === 'HQ' && roleLevel <= 30 })`
  (mirroring `app/src/app/marketing/_lib.ts` → `getMarketingPageContext`).
- Navigation visibility (sidebar/top-nav/landing child) is keyed to the same `marketing.module.view`
  parent gate; sidebar visibility alone is insufficient — each page and API re-checks.
- Public QR registration is outside S&A (service-role token resolution, no `authorizeOperation`).

**Deferred granular-access phase (future, recommendations not yet approved).** Later, `event.*`
permissions can subdivide the module. Keys must be `module.resource.action` (3 parts — `sa_permissions`
CHECK), so shorthand `event.view`/`event.manage`/`event.export` are invalid:

| Capability | Permission (proposed) | Surface |
|---|---|---|
| View events / overview / counts | `event.event.view` | page guard + list API |
| Create / edit / cancel events | `event.event.manage` | form + write API |
| Assign staff / generate / revoke QRs | `event.event.manage` | Staff & QR tab |
| View / search / filter visitors | `event.registration.view` | Visitors tab + list API |
| Correct / delete registrations (later) | `event.registration.manage` | deferred |
| View reports (staff comparison, new/returning) | `event.report.view` | reports |
| Export visitors | `event.registration.export` | export API |
| Public registration (anonymous) | **none** | `/api/event-management/public/*` |

Notes (deferred phase):
- `event.event.*` is redundant (module = resource) but honest and consistent with the 3-part format;
  alternative naming is a decision for the user (see HANDOFF.md). `export` is a new action suffix not in
  `labels.ts` `ACTIONS` — it falls back to `titleCase('export')` ("Export …"); alternatively gate export
  on `event.registration.view` (matching `journey/download-qr-excel`, which gates on `customer.campaign.manage`).
- When registered, seed `sa_permissions` + `sa_migration_modes` with **`NEW_ENFORCED`** (Event
  Management is new — no legacy evaluator exists, so it must not be `LEGACY_ENFORCED`).
- Registering a permission and granting it are different operations; do not silently extend Full Access.

**Deferred S&A wiring (future phase, target on issues-fixing-oct2):**
1. `modules.ts` — add `event` to the `customer_growth` match and an
   `{ id:'event', name:'Event Management', match: mod('event') }` area → groups keys under
   "Customer & Growth · Event Management" in Policies / Group Policies / Migration Modes.
2. `labels.ts` — add `event: 'Customer & Growth'` to `MODULE_GROUPS` (and optional `event.*` nouns in `RESOURCES`).
3. Migration — insert `event.*` keys into `sa_permissions` and `sa_migration_modes` (mode `NEW_ENFORCED`).
4. `customerGrowthNav.ts` — add `{ id:'event-management', … }` child to `cg-marketing` (below Road Tour).
5. `nav-access.ts` (issues-fixing-oct2) — add `event-management: { org: [ …event keys… ] }` to
   `CUSTOMER_GROWTH_DESTINATIONS` (mirror `roadtour`).
6. Every admin page/API — swap the parent `marketing.module.view` gate for the matching `event.*` key
   + `organizationResource(...)`; org scope comes from the server (never request input).

- **Public QR registration is separate** from staff/admin: it never requires a Group Policy and uses
  service-role server resolution of the token (like `validate_roadtour_qr_token`) — no `authorizeOperation`.
- **Full Access (deferred):** `customer-growth-full-access` (issues-fixing-oct2 only) will NOT cover
  `event.*` until `sa_extend_standard_policy('customer-growth-full-access', ['event.*'], reason)` is run.
  Surface `sa_standard_policy_drift()`; do not silently modify grants. Registering a permission key and
  granting it to a policy are different operations — seeding `sa_permissions` does not grant access.

## 4. API & public registration design

### Admin APIs (authenticated, org-scoped — parent gate, service-role DB access)
- All Event Management admin APIs are gated by the Marketing parent permission
  `marketing.module.view` via `guardUserOperation(userId, 'marketing.module.view', { resourceType: 'marketing_module' })`
  (or `authorizeOperation` + `organizationResource('marketing_module', orgId)` with the org id
  server-derived). No `event.*` keys are introduced in this phase.
- DB reads/writes use the **service-role client** with explicit `organization_id` filtering and
  event/contact/token ownership checks (see "Authorization & tenant isolation — Strategy B" below);
  service role bypasses RLS, so org scope must be explicit in code.
- `GET/POST /api/event-management/events` — list/create.
- `GET/PATCH /api/event-management/events/[eventId]` — read/update; org-scoped via `organizationResource`.
- `POST /api/event-management/events/[eventId]/qr` — generate staff/booth QR; returns token (never PII).
- `GET /api/event-management/events/[eventId]/qr/[token]/image` — render PNG via `qrcode`
  (mirror `/api/roadtour/qr-image/[token]`).
- `GET /api/event-management/events/[eventId]/registrations` — search/filter.
- `GET /api/event-management/events/[eventId]/stats` — counts + per-staff comparison.
- `GET /api/event-management/events/[eventId]/registrations/export` — CSV/Excel via ExcelJS
  (gated by the parent permission in this phase; the deferred `event.registration.export` key applies later).

### Public APIs (anonymous, rate-limited, no PII leakage)
- `GET /api/event-management/public/event/[token]` — resolves token server-side → returns only the
  **non-sensitive** form config (event name, brand, required/optional flags, consent text). Returns
  404/410 for revoked/expired/not-active events. Never returns staff or contact data.
- `POST /api/event-management/public/register` — body = token + form fields. Server:
  1. rate-limit by `clientIpFromHeaders` (`checkRateLimit`);
  2. resolve token → event + staff (server-side; ignore any client staff id);
  3. validate dates/status (allow only when active and within the effective open/close window);
  4. normalize phone/email, run duplicate rule, enforce required fields;
  5. in **one transaction / RPC** insert `event_contacts` + `event_registrations` + `event_consents`
     (all-or-nothing; on any failure no partial rows remain);
  6. return a **generic** confirmation id (opaque) — no personal data echo, no existing-visitor data,
     no previous confirmation ids, no staff attribution. Duplicate/returning resubmissions return the
     same generic confirmation and never overwrite stored personal data, consent, or the original
     attribution.

- **Public routes must be added to `app/middleware.ts` `PUBLIC_PATHS`** (e.g. `/event`, `/api/event-management/public`).

### Atomic registration (single transaction / RPC)
- Contact + registration + consent are written in **one transaction** (or a single `SECURITY DEFINER`
  RPC, e.g. `register_event_visitor(token, fields)`), so a failure at any step rolls back every row —
  no partial contact without consent, no registration without contact.
- `event_contacts` enforces `NOT NULL` name + phone and `UNIQUE (event_id, phone_normalized)`;
  `event_registrations` enforces `UNIQUE (event_id, contact_id)`. Concurrent duplicate submissions hit
  one of these unique constraints, which the transaction maps to the existing contact + registration
  and returns the same generic confirmation. Counts do not increase and no partial rows remain.
- Anonymous resubmissions are idempotent and **non-mutating**: they never overwrite stored personal
  details, consent rows, the original QR source, or the first successful registration source
  (including booth).

### Authorization & tenant isolation — Strategy B (deny direct DB access)

The parent permission `marketing.module.view` has **no proven database equivalent usable inside RLS**:
S&A evaluation runs server-side in the app (`app/src/lib/security-access/authorization.ts`
`loadNewPolicy`/`evaluateNewPolicy` via the service-role client), and the DB evaluator
`sa_readable_organizations(actor, permission)` is `SECURITY DEFINER` but **`REVOKE ALL … FROM public,
anon, authenticated` / `GRANT … TO service_role` only** (see
`20260930100000_sa_stage2d_deferred_closure.sql`). RLS therefore cannot check the parent permission for
the `authenticated` role. The chosen strategy is to **deny direct access** and route everything through
the server:

- **Tables (`event_*`): `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL ON … FROM public, anon,
  authenticated`** (mirrors `inventory_cutoff_allocation_requests` in
  `20260801190000_inventory_cutoff_allocation_resolver.sql`). No `authenticated`/`anon` SELECT, INSERT,
  UPDATE or DELETE, and no permissive RLS policies are created for them. Only `service_role` (and the
  table owner) can touch these tables.
- **RPCs (`validate_event_qr_token`, `register_event_visitor`): `SECURITY DEFINER`,
  `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO service_role`
  only.** Removing the default `PUBLIC` EXECUTE prevents `anon`/`authenticated` from invoking them; the
  atomic registration RPC is reachable only through the public server endpoint.
- **Admin access** is via server endpoints that first call
  `authorizeOperation`/`guardUserOperation(userId, 'marketing.module.view')` +
  `organizationResource('marketing_module', organizationId)`, then read/write with the **service-role
  client**, applying **explicit `organization_id` filtering** and ownership checks. Service role bypasses
  RLS, so org isolation is enforced in code — never left to RLS alone.
- **Event ownership checks on every supplied id:** before acting on any `event_id` / `contact_id` /
  `qr_token_id`, the server (or the SECURITY DEFINER RPC) verifies the row belongs to the caller's
  organization and that the contact/token belong to the same event (composite FKs + explicit checks).
- **Public registration** is token-scoped: the public endpoint resolves the token with the service-role
  client, rate-limits, then invokes the service-role-only atomic RPC. Anonymous users never read
  visitor/contact lists or invoke protected RPCs directly.
- **Users without Marketing access are blocked at the DB:** they hold no table privileges (revoked) and
  no RPC EXECUTE (revoked), so direct Supabase access yields nothing. Organization membership alone
  grants no access to event personal data.

**Cross-entity consistency (unchanged, database constraints):**
- `event_registrations(event_id, contact_id)` → `event_contacts(event_id, id)` (contact belongs to the
  same event/org);
- `event_registrations(event_id, qr_token_id)` → `event_qr_tokens(event_id, id)` (token belongs to the
  same event/org);
- `event_qr_tokens.staff_user_id` must reference an `event_staff(event_id, user_id)` row for that event
  (staff are assigned to the event);
- every `event_*` row shares the event's `organization_id`, so a contact, registration, QR token and
  assigned staff always belong to the same event and organization.

**Future granular phase:** once `event.*` keys exist, a later migration can either add per-key RLS
policies (only if a DB evaluator is made available to `authenticated`) or keep the deny-direct-access +
server enforcement pattern, mirroring the per-key `authorizeOperation`.

---

## 5. Duplicate, attribution & date rules (proposed decisions)

### Duplicate rule (approved)
- `phone_normalized` lives **only** on `event_contacts` (single source of truth) and is **`NOT NULL`**
  (phone is mandatory this version). The dedupe constraint is `UNIQUE (event_id, phone_normalized)` on
  `event_contacts` — **not** on `event_registrations`, which references the contact via `contact_id`
  and stores no `phone_normalized` of its own.
- `event_registrations` additionally enforces `UNIQUE (event_id, contact_id)` so a contact maps to
  exactly one registration per event.
- Because the canonical contract is E.164 (`+601…`), `normalizePhoneE164` is reused.
- **Concurrency:** the two unique constraints are the final guard. Two simultaneous same-phone
  submissions both try to insert; the second hits a unique violation, which the atomic registration
  transaction maps to the existing contact + registration (idempotent). The result is exactly one
  contact and one registration; counts never increase and no partial rows remain.

### Attribution
- **First successful registration source is fixed, including booth:** `attributed_staff_user_id` is
  set once on the first successful registration and never overwritten. Booth → staff A resubmission
  remains booth; staff A → staff B remains staff A.
- **One authoritative representation:** `attributed_staff_user_id` (NULL = booth) is the single
  attribution field. Staff-vs-booth kind is derived from `qr_token_id` → `event_qr_tokens.kind`, never
  stored twice, so redundant staff fields cannot disagree.
- **QR source is historically stable:** `qr_token_id` records the original token; tokens are
  soft-revoked (`status`) and never hard-deleted, so the source survives token revocation and staff
  reassignment.
- **General booth must not inflate staff ranking:** booth registrations have
  `attributed_staff_user_id = NULL` and are counted only in the event total, never in a staff's tally.
- **Registrations, not scans:** the metric is `event_registrations` rows; raw QR opens are not
  counted. Metrics describe registrations, not verified identities.

### Registration dates (defaults + overrides)
- Default: registration opens at the event's `starts_at` and closes at the event's `ends_at`.
- Admin overrides: `registration_opens_at` / `registration_closes_at` are optional explicit
  overrides. When `NULL`, the effective window falls back to `starts_at`/`ends_at`. `NULL` never means
  "always open"; an event should always have explicit start/end dates.

### Returning contacts (org + brand scoped)
- "Returning" = the same normalized phone seen in an earlier event **within the same organization and
  brand**. Matching is scoped to `organization_id` **and** `brand_id`; do not silently match across
  brands.
- A nullable `user_id` link on `event_contacts` is an **explicit** identity link only. Do **not** link
  an anonymous contact to a user solely because a submitted phone/email matches — identity linkage
  must be explicit, not inferred from field equality.

### Status & scope
- **Draft/active/ended/cancelled:** public registration only when `status = 'active'`; draft is
  admin-visible only; ended/cancelled stop new submissions but keep historical rows.
- **Outside event dates:** reject if now is outside the effective open/close window (event start/end
  or explicit overrides), evaluated in the event timezone.
- **Brand/company isolation:** every event is owned by `organization_id`; lists/stats/export are
  scoped to the caller's org; Ellbow events are just events with `brand_id` = Ellbow.
- **Anonymous must not expose existing data:** the public form and confirmation never echo stored
  visitor data or staff attribution; identity match (new/returning) is an admin-side, org-scoped view
  only.
- **Personal data not in QR URL:** the token is an opaque random value; no name/phone/email in the URL.

## 6. Proposed migration sequence (`supabase/migrations/`)

Requested naming kept; execution order is manual and recorded in
`PRODUCTION_MIGRATION_STATUS.md`. Each file's header must state purpose, prerequisites,
order, verification queries, and rollback notes.

| # | File | Purpose | Depends on |
|---|---|---|---|
| event01 | `20261007_event01_create_event_tables.sql` | `event_events`, `event_staff`, `event_qr_tokens`, `event_contacts`, `event_registrations`, `event_consents` + indexes + `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL … FROM public, anon, authenticated` (deny direct access) | existing `users`/`organizations`/`brands` |
| event02 | `20261007_event02_event_qr_functions.sql` | `SECURITY DEFINER` `validate_event_qr_token(token)` + atomic `register_event_visitor` RPCs + `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO service_role` + duplicate/attribution helpers | event01 |
| event03 | `20261007_event03_event_rls_and_grants.sql` | finalize RLS (no anon/authenticated policies) + composite FKs + verify ownership/org-isolation constraints | event01–02 |

> **Deferred (future granular-access phase):** a later migration registers `event.*` keys in
> `sa_permissions` + `sa_migration_modes` (mode `NEW_ENFORCED`) and, only after approval, extends
> `customer-growth-full-access` via `sa_extend_standard_policy(...)` once the shared S&A framework is
> available via the agreed sequence (see README.md / HANDOFF.md). Do not create a parallel
> S&A/navigation framework. Initial access needs none of this — it uses the Marketing parent gate.

## 7. Phases & acceptance criteria

**Phase 0 — decisions.** The core business decisions are now approved (name/phone mandatory, no OTP,
optional email/cat fields, one phone per event, first successful source fixed including booth).
Initial access is the Marketing parent gate `marketing.module.view` — no `event.*` keys or shared-S&A
framework are required first. The `event.*` granular-access phase (permissions, seed migration, Full
Access extension) is deferred until the shared S&A framework is available on this branch via the
agreed sequence (complete/validate S&A on `issues-fixing-oct2` → integrate to staging → update
`event_management` from staging). Blocking only for that deferred phase.

**Phase 1 — data + authz. ✅ DONE.** Migrations event01–event03 (tables + deny-direct-access RLS + QR
functions + RPC privilege revocation) written under `supabase/migrations/` and validated in an
isolated disposable Postgres 17 database (26 assertions + a two-connection concurrency check).
`anon`/`authenticated` cannot read/write event tables or invoke event RPCs; `service_role` can.
Migrations are **NOT applied** to any existing environment. (The `event.*` keys + `modules.ts`
event area are deferred to the future granular-access phase.)

**Phase 2 — admin CRUD. ✅ DONE.** Events list/create/edit + Staff & QR + booth QR render, all gated
by the Marketing parent gate with server-derived org scope.

**Phase 3 — public registration. ✅ DONE.** `/event/[token]` Ellbow form + `POST public/register` +
middleware public paths (`/event`, `/api/event-management/public`). Token resolves server-side; name
+ phone mandatory (email/cat optional) validated server-side; duplicate rule + fixed first source
(booth → staff A stays booth; staff A → staff B stays staff A) enforced in the atomic RPC; no PII in
QR URL; rate-limited.

**Phase 4 — visitors/reports/export. ✅ DONE.** Visitors tab, search/filter, stats + staff comparison,
export (CSV + xlsx with spreadsheet formula-injection protection). Export gated by the parent
permission (deferred `event.registration.export` later); booth never inflates staff rank.

**Phase 5 — navigation. ✅ DONE.** Event Management added below Road Tour in `customerGrowthNav.ts`
(and `marketingNav.ts`), with breadcrumbs in `eventManagementNav.ts`. Visibility is keyed to the
parent `marketing.module.view`. The destination-based nav mapping (`nav-access.ts`) and `event` area
are for the deferred granular-access phase (issues-fixing-oct2) — no parallel framework created.

## 8. Test & manual verification plan

### Automated (Vitest, colocated)
- `duplicate.test.ts` — E.164 normalization + duplicate policy (mirror
  `app/src/lib/roadtour/duplicate-protection.test.ts`); simultaneous same-phone submissions converge
  to one contact + one registration.
- `attribution.test.ts` — first successful source fixed: booth → staff A stays booth; staff A →
  staff B stays staff A; booth never attributed to a staff tally.
- `validation/registration.test.ts` — zod schema: name + phone mandatory; email/cat optional;
  Malaysian mobile format/length/prefix.
- `app/src/app/api/event-management/public/register/route.test.ts` — rate-limit, token resolution,
  invalid/expired/outside-dates, idempotent resubmit (generic confirmation, no existing-data leak),
  consent rows, mandatory-field rejection.
- `app/src/app/api/event-management/events/route.test.ts` — parent permission gate
  (`guardUserOperation` with `marketing.module.view`) and org isolation (caller cannot read another
  org's events/registrations).
- `eventManagementNav.test.ts` — nav id added, view→path maps, breadcrumb (mirror `roadtourNav.test.ts`).
- `app/src/components/journey/petfood/…test.tsx` style test for the public form using Ellbow assets.

### Database tests (required — prove the actual guarantees)
Mocked route tests alone do not prove constraint, atomicity or access-control behavior. Add real
database tests (prefer a local/CI Supabase or a `pgTAP`/`supabase test` runner) that:
- insert two concurrent same-phone contacts and assert exactly one contact + one registration;
- assert `UNIQUE (event_id, phone_normalized)` on `event_contacts` and `UNIQUE (event_id, contact_id)`
  on `event_registrations` reject violations;
- assert `event_contacts.name` / `event_contacts.phone_normalized` reject `NULL`;
- assert `register_event_visitor` rolls back all rows when consent/registration insertion fails;
- assert cross-entity FKs keep contact/token in the same event/org;
- assert a same-org user **without** `marketing.module.view` cannot directly SELECT/INSERT/UPDATE/
  DELETE `event_*` rows, and cannot `EXECUTE` the event RPCs;
- assert cross-org access fails (an authenticated user in org A cannot read/write org B's event data);
- assert `anon` cannot read visitor/contact lists or invoke protected RPCs;
- assert authorized server operations (via service role) remain organization-scoped;
- assert public registration stays token-scoped, atomic and duplicate-safe.

### Manual (staging)
1. Create an Ellbow event, assign two staff, generate their QRs + booth QR; verify 3 distinct PNGs.
2. Scan staff A's QR on a phone → submit; scan booth QR → submit; verify staff A count = 1, booth
   not in staff tally, event total = 2.
3. Resubmit the same phone via staff B's QR → confirm idempotent, attribution stays with staff A
   (staff A → staff B retains staff A).
4. Submit via booth then resubmit the same phone via staff A → attribution stays booth
   (booth → staff A retains booth).
5. Verify a user without `event.*` sees no sidebar entry and gets 403 on the APIs; verify a user in
   org A cannot read org B's registrations.
6. Verify export CSV contains only the caller's org rows.

### Rollback considerations (per migration)
Each migration ships with a commented rollback section (DROP/CREATE OR REPLACE) and a verification
query; the user runs migrations manually and reviews `PRODUCTION_MIGRATION_STATUS.md`.

### Gitignore note for tests
`.gitignore` ignores `*.test.ts` by default; add an explicit `!` un-ignore rule for each new
Event Management test path (or use `git add -f`) so tests are tracked.




