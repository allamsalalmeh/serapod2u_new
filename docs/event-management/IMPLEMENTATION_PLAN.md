# Event Management — Implementation Plan (Proposed)

Status: **proposal only.** Nothing below is implemented. It describes how the module
should be built on the `event_management` branch (`origin/staging` @ `9e27404d`) using the
conventions verified in ASSESSMENT.md.

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
    attribution.ts               # first-valid staff attribution, booth-vs-staff rules
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
  registration_opens_at, registration_closes_at (nullable = always open),
  form_config jsonb,           # required/optional field flags + consent text
  booth_qr_token text unique,  # general booth QR
  created_by → users

event_staff
  id, event_id → event_events, user_id → users,           # participating staff
  unique(event_id, user_id)

event_qr_tokens
  id, event_id → event_events, staff_user_id → users (null = booth),
  token text unique (encode(gen_random_bytes(32),'base64url')),
  kind (staff|booth), status (active|revoked|expired), created_at

event_contacts                     # event-specific contact entity (anonymous-safe)
  id, event_id, name, phone_normalized text, email_normalized text,
  cat_name, cat_breed text (incl. 'Tidak pasti'), current_cat_food text (optional),
  user_id → users (nullable, identity link only, never created)
  # NO password/auth; personal data lives here, not in QR URLs

event_registrations
  id, event_id, contact_id → event_contacts, qr_token_id → event_qr_tokens,
  staff_user_id → users (resolved server-side from token; null for booth),
  attributed_staff_user_id → users (first valid staff only),
  submitted_at timestamptz, ip text, source (qr|booth)
  unique(event_id, phone_normalized)  -- proposed duplicate rule (see §5)

event_consents                       # registration consent vs marketing consent separated
  id, registration_id, kind (registration|marketing), granted boolean, recorded_at
```

**Storage rules:**
- Dates stored `timestamptz` (UTC); "Asia/Kuala_Lumpur" is a display/config concern. Event date
  boundaries are evaluated in the event's `timezone` (mirrors `roadtour_runs` + `20260411_fix_roadtour_timezone.sql`).
- `phone_normalized`/`email_normalized` reuse `normalizePhoneE164` / `identity_normalize_email`.
- QR tokens contain no personal data and resolve event+staff **server-side** only.

### Permission matrix (proposed `event.*` namespace, 3-part keys)

Permission keys must be `module.resource.action` (3 parts — `sa_permissions` CHECK constraint), so the
shorthand `event.view` / `event.manage` / `event.export` are **invalid**. Use module `event` (grouped
under Customer & Growth, like `roadtour`).

| Capability | Permission (proposed) | Surface |
|---|---|---|
| View events / overview / counts | `event.event.view` | page guard + list API |
| Create / edit / cancel events | `event.event.manage` | form + write API |
| Assign staff / generate / revoke QRs | `event.event.manage` | Staff & QR tab |
| View / search / filter visitors | `event.registration.view` | Visitors tab + list API |
| Correct / delete registrations (Phase 2) | `event.registration.manage` | deferred |
| View reports (staff comparison, new/returning) | `event.report.view` | reports |
| Export visitors | `event.registration.export` | export API |
| Public registration (anonymous) | **none** | `/api/event-management/public/*` |

Notes:
- `event.event.*` is redundant (module = resource) but honest and consistent with the 3-part format;
  alternative naming is a decision for the user (see HANDOFF.md). `export` is a new action suffix not in
  `labels.ts` `ACTIONS` — it falls back to `titleCase('export')` ("Export …"); alternatively gate export
  on `event.registration.view` (matching `journey/download-qr-excel`, which gates on `customer.campaign.manage`).
- Register keys in `sa_permissions` and seed `sa_migration_modes` with **`NEW_ENFORCED`** (Event
  Management is new — no legacy evaluator exists, so it must not be `LEGACY_ENFORCED`).

### S&A wiring (what to touch — target state on issues-fixing-oct2)
1. `modules.ts` — add `event` to the `customer_growth` match and an
   `{ id:'event', name:'Event Management', match: mod('event') }` area → groups keys under
   "Customer & Growth · Event Management" in Policies / Group Policies / Migration Modes.
2. `labels.ts` — add `event: 'Customer & Growth'` to `MODULE_GROUPS` (and optional `event.*` nouns in `RESOURCES`).
3. Migration — insert `event.*` keys into `sa_permissions` and `sa_migration_modes` (mode `NEW_ENFORCED`).
4. `customerGrowthNav.ts` — add `{ id:'event-management', … }` child to `cg-marketing` (below Road Tour).
5. `nav-access.ts` (issues-fixing-oct2) — add `event-management: { org: ['event.event.view','event.event.manage','event.registration.view'] }` to `CUSTOMER_GROWTH_DESTINATIONS` (mirror `roadtour`).
6. Every admin page/API — `authorizeOperation`/`guardUserOperation` + `organizationResource(...)` with the
   same `event.*` key; org scope comes from the server (never request input).
7. **Consistency rule:** sidebar visibility (destination), page guard and API guard use the same
   `event.*` key + org scope — no surface uses a different check.

- **Public QR registration is separate** from staff/admin: it never requires a Group Policy and uses
  service-role server resolution of the token (like `validate_roadtour_qr_token`) — no `authorizeOperation`.
- **Full Access:** `customer-growth-full-access` (issues-fixing-oct2 only) will NOT cover `event.*` until
  `sa_extend_standard_policy('customer-growth-full-access', ['event.*'], reason)` is run. Surface
  `sa_standard_policy_drift()`; do not silently modify grants.

## 4. API & public registration design

### Admin APIs (authenticated, org-scoped)
- `GET/POST /api/event-management/events` — list/create; `guardUserOperation(userId, 'event.event.manage')`
  for POST, `'event.event.view'` for GET.
- `GET/PATCH /api/event-management/events/[eventId]` — read/update; org-scoped via `organizationResource`.
- `POST /api/event-management/events/[eventId]/qr` — generate staff/booth QR; returns token (never PII).
- `GET /api/event-management/events/[eventId]/qr/[token]/image` — render PNG via `qrcode`
  (mirror `/api/roadtour/qr-image/[token]`).
- `GET /api/event-management/events/[eventId]/registrations` — search/filter; `'event.registration.view'`.
- `GET /api/event-management/events/[eventId]/stats` — counts + per-staff comparison; `'event.report.view'`.
- `GET /api/event-management/events/[eventId]/registrations/export` — CSV/Excel via ExcelJS;
  `'event.registration.export'`.

### Public APIs (anonymous, rate-limited, no PII leakage)
- `GET /api/event-management/public/event/[token]` — resolves token server-side → returns only the
  **non-sensitive** form config (event name, brand, required/optional flags, consent text). Returns
  404/410 for revoked/expired/not-active events. Never returns staff or contact data.
- `POST /api/event-management/public/register` — body = token + form fields. Server:
  1. rate-limit by `clientIpFromHeaders` (`checkRateLimit`);
  2. resolve token → event + staff (server-side; ignore any client staff id);
  3. validate dates/status (allow only when active and within open/close window);
  4. normalize phone/email, run duplicate rule, enforce required fields;
  5. insert `event_contacts` + `event_registrations` + `event_consents`;
  6. return a confirmation id (opaque) — no personal data echo, no existing-visitor data.

- **Public routes must be added to `app/middleware.ts` `PUBLIC_PATHS`** (e.g. `/event`, `/api/event-management/public`).

### Authorization & tenant scope
- Every admin API reads the caller's org from the server (`getEllbowContext`-style) — never from the request.
- RLS: `event_*` tables scoped to `organization_id` via `auth.uid()` org membership, matching the
  `roadtour_*` hardening (`20260510_roadtour_hardening_and_org_rls.sql`).
- Public endpoints use the service-role/admin client to resolve tokens (like `resolveRoadtourByToken`),
  and never expose visitor lists or contact rows to anonymous callers.

---

## 5. Duplicate & attribution rules (proposed decisions)

- **Duplicate rule:** one normalized phone per event (`unique(event_id, phone_normalized)`). Because
  the canonical contract is E.164 (`+601…`), `normalizePhoneE164` is reused. This is **proposed**, not
  final — see HANDOFF.md.
- **No phone or email:** allow a registration keyed on name only, but flag it as not reliably
  identifiable for "new vs returning" (it is excluded from dedupe/returning logic). Record
  `has_identifier` to make this explicit.
- **Resubmissions:** return the existing confirmation (idempotent) rather than a duplicate row when the
  duplicate rule matches; use a DB unique constraint as the final guard against concurrent submits.
- **Concurrent submissions:** rely on the `unique(event_id, phone_normalized)` constraint; on conflict,
  treat as an existing registration (do not double-count).
- **First valid staff attribution stays fixed:** once `attributed_staff_user_id` is set (non-null) from
  a valid staff QR, a later resubmission or second scan does not overwrite it.
- **General booth must not inflate staff ranking:** booth registrations have `staff_user_id = NULL` and
  are counted only in the event total, never in a staff's tally. `kind = 'booth'` is explicit.
- **Registrations, not scans:** the metric is `event_registrations` rows; raw QR opens are not counted.
- **Returning across events:** "returning" = the same normalized phone (or email, or linked `user_id`)
  seen in an earlier event within the same organization. Requires an identity index across
  `event_contacts` (proposed) — flag as a later phase if exact identity semantics are not yet decided.
- **Draft/active/ended/cancelled:** public registration only when `status = 'active'`; draft is
  admin-visible only; ended/cancelled stop new submissions but keep historical rows.
- **Outside event dates:** reject if now is outside `registration_opens_at`/`registration_closes_at`
  (when configured), evaluated in the event timezone.
- **Brand/company isolation:** every event is owned by `organization_id`; lists/stats/export are scoped
  to the caller's org; Ellbow events are just events with `brand_id` = Ellbow.
- **Anonymous must not expose existing data:** the public form and confirmation never echo stored
  visitor data; identity match (new/returning) is an admin-side, org-scoped view only.
- **Personal data not in QR URL:** the token is an opaque random value; no name/phone/email in the URL.

## 6. Proposed migration sequence (`supabase/migrations/`)

Requested naming kept; execution order is manual and recorded in
`PRODUCTION_MIGRATION_STATUS.md`. Each file's header must state purpose, prerequisites,
order, verification queries, and rollback notes.

| # | File | Purpose | Depends on |
|---|---|---|---|
| event01 | `20261007_event01_create_event_tables.sql` | `event_events`, `event_staff`, `event_qr_tokens`, `event_contacts`, `event_registrations`, `event_consents` + indexes + RLS | existing `users`/`organizations`/`brands` |
| event02 | `20261007_event02_seed_event_permissions.sql` | register `event.*` in `sa_permissions` + seed `sa_migration_modes` (mode `NEW_ENFORCED`) | `sa_permissions`/`sa_migration_modes` foundation (wave1) |
| event03 | `20261007_event03_event_qr_functions.sql` | `validate_event_qr_token(token)` RPC + duplicate/attribution helpers | event01 |
| event04 | `20261007_event04_event_rls_and_grants.sql` | finalize RLS + grants to `authenticated`/`service_role` | event01–03 |

> If the S&A nav-access / group-policies work is required, a later migration will extend
> `customer-growth-full-access` (or add an `event` area) — only after the user approves it.

## 7. Phases & acceptance criteria

**Phase 0 — decisions.** Answer HANDOFF.md open questions (contact required/optional, dedupe rule,
staff-attribution fixity, permission naming, S&A base). Blocking.

**Phase 1 — data + authz.** Migrations event01–event04 + `modules.ts` event area + `event.*`
permission keys. Acceptance: migrations apply cleanly on staging; `event.*` appear in the S&A
permission catalogue grouped under Customer & Growth → Event Management.

**Phase 2 — admin CRUD.** Events list/create/edit + Staff & QR + booth QR render.
Acceptance: org isolation holds; a user with only `event.event.view` cannot create; QR images render.

**Phase 3 — public registration.** `/event/[token]` Ellbow form + `POST public/register` +
middleware public path. Acceptance: no auth required; token resolves server-side; duplicate rule
enforced; booth vs staff attribution correct; no PII in QR URL; rate-limited.

**Phase 4 — visitors/reports/export.** Visitors tab, search/filter, stats + staff comparison,
new/returning, export. Acceptance: exports gate on `event.registration.export`; booth never inflates staff rank.

**Phase 5 — navigation.** Add Event Management below Road Tour in `customerGrowthNav.ts`
(and reconcile `marketingNav.ts`), add `event` area + destination mapping, breadcrumbs.
Acceptance: shows in overview card + top dropdown; hidden without an `event.*` permission.

## 8. Test & manual verification plan

### Automated (Vitest, colocated)
- `duplicate.test.ts` — E.164 normalization + duplicate policy (mirror
  `app/src/lib/roadtour/duplicate-protection.test.ts`).
- `attribution.test.ts` — first-valid staff fixed; booth never attributed to staff.
- `validation/registration.test.ts` — zod schema required/optional fields.
- `app/src/app/api/event-management/public/register/route.test.ts` — rate-limit, token resolution,
  invalid/expired/outside-dates, idempotent resubmit, consent rows.
- `app/src/app/api/event-management/events/route.test.ts` — permission gate (`guardUserOperation`).
- `eventManagementNav.test.ts` — nav id added, view→path maps, breadcrumb (mirror `roadtourNav.test.ts`).
- `app/src/components/journey/petfood/…test.tsx` style test for the public form using Ellbow assets.

### Manual (staging)
1. Create an Ellbow event, assign two staff, generate their QRs + booth QR; verify 3 distinct PNGs.
2. Scan staff A's QR on a phone → submit; scan booth QR → submit; verify staff A count = 1, booth
   not in staff tally, event total = 2.
3. Resubmit the same phone via staff B's QR → confirm idempotent, attribution stays with staff A.
4. Register with no phone/email → accepted and excluded from returning metrics.
5. Verify a user without `event.*` sees no sidebar entry and gets 403 on the APIs.
6. Verify export CSV contains only the caller's org rows.

### Rollback considerations (per migration)
Each migration ships with a commented rollback section (DROP/CREATE OR REPLACE) and a verification
query; the user runs migrations manually and reviews `PRODUCTION_MIGRATION_STATUS.md`.

### Gitignore note for tests
`.gitignore` ignores `*.test.ts` by default; add an explicit `!` un-ignore rule for each new
Event Management test path (or use `git add -f`) so tests are tracked.




