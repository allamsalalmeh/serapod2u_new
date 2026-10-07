# Event Management Module — Planning Documents

> **Status: implemented (Phase 1–5), locally verified, and integrated into
> `issues-fixing-oct2`.** The module is now developed on the
> `issues-fixing-oct2` branch in `/Users/edierwan/serapod2u_dev`. `event_management`
> (source branch) was merged locally (merge commit `9129fc09`) and its Event
> Management navigation adapted to the destination-based S&A navigation framework
> (`CUSTOMER_GROWTH_DESTINATIONS['event-management']` gated by `marketing.module.view`).
> Migrations remain **CREATED / NOT APPLIED** — awaiting the user's manual
> migration step (see `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`).
> No push/deploy was performed.

This folder is the entry point for the next coder working on the Event
Management module. It records what was verified in the repository, what is
still undecided, and what the next implementation step is.

## Branch and base

| Item | Value |
|---|---|
| Branch | `event_management` |
| Base branch | `origin/staging` |
| Base commit | `9e27404d` (`fix(orders): atomic order save + index order_items FK probes`) |
| Current HEAD | `d7388f7d` (2 documentation-only commits ahead of `origin/staging`) |
| Working tree | clean |

### Historical note (branch creation vs current state)

The `event_management` branch was originally created against `origin/staging` @
`9e27404d` rather than branching from `issues-fixing-oct2`, so the new module would
not sweep in the in-flight Security & Access / finance / HR work living on that
branch. Early notes described that as "14 unpushed commits + 326 uncommitted
changes" and a working tree "preserved in `stash@{0}`".

**Current state (verified):** `git stash list` is empty (no `stash@{0}` remains)
and `origin/issues-fixing-oct2` is now **1 commit** ahead of `origin/staging`.
Those earlier counts were point-in-time observations, not current facts. This
checkout is a clean `event_management` worktree with two documentation-only commits
on top of `origin/staging`.

Do **not** push, merge, rebase, cherry-pick, deploy, or run migrations from this
branch.

## Reading order

1. `README.md` — this file (status, scope, next action).
2. `ASSESSMENT.md` — verified repository evidence, reusable pieces, risks, and
   the Ellbow asset / migration-naming findings.
3. `IMPLEMENTATION_PLAN.md` — proposed folder/route layout, data model,
   permission matrix, API design, and phased plan.
4. `HANDOFF.md` — decisions (confirmed vs pending vs proposed),
   and a ready-to-copy prompt for the next session.

## Confirmed scope (Phase 1)

- Simple event registration module, first for the **Ellbow** cat-food brand.
- Public flow: scan QR → public mobile form → submit simple info → confirmation.
  **No visitor login.**
- Admin: create/manage events, assign staff, one QR per staff per event, a
  general booth QR, view attendees/counts, compare staff registrations, spot
  new/returning contacts where reliably identifiable, search/filter/export.
- Module tabs: Overview / Events / Settings. Inside an event: Overview /
  Visitors / Staff & QR / Settings.
- Navigation: Customer & Growth → Marketing → Event Management, placed directly
  below Road Tour (sidebar + Marketing overview card + top dropdown).
- S&A permissions group under **Customer & Growth → Event Management** in
  Policies, Group Policies and Migration Modes (future granular-access phase).
  Initial sidebar visibility, page access and API authorization use the existing
  Marketing parent gate `marketing.module.view` + organization scope.

**Explicitly out of scope** (do not add): ticketing, payments, prizes, loyalty
points, sample inventory, automated broadcasts, budgeting.

## Access model — parent gate now, granular permissions later (latest)

### Verified parent gate (existing on this base)
- The repo's S&A authorization primitive is `app/src/lib/security-access/operation.ts`
  (`authorizeOperation`, `guardUserOperation`, `organizationResource`).
- Event Management sits under **Customer & Growth → Marketing** (below Road Tour). The existing
  **Marketing module-entry gate** is the parent access check:
  `app/src/app/marketing/_lib.ts` → `getMarketingPageContext()` →
  `authorizeOperation({ permission: 'marketing.module.view', resource: organizationResource('marketing_module', organizationId), legacy: () => orgType === 'HQ' && roleLevel <= 30 })`.
- **Gap:** there is **no** Customer & Growth domain-level parent permission — the domain landing
  (`app/src/app/customer-growth/_lib.ts`) returns `canViewCustomerGrowth = true` for all authenticated
  users. The nearest verified parent gate is Marketing's `marketing.module.view`.

### Initial access (this direction)
- Initial Event Management access uses `marketing.module.view` consistently for navigation, admin
  pages and APIs, with org isolation via `organizationResource('marketing_module', orgId)` (org id
  always server-derived, never from the request). Sidebar visibility alone is insufficient — every
  page and API re-checks.
- **Database enforcement (Strategy B):** `event_*` tables and RPCs deny direct access to
  `anon`/`authenticated` — RLS enabled with no permissive policies, table grants revoked, and RPC
  `PUBLIC` EXECUTE revoked (`GRANT … TO service_role` only). All access flows through server endpoints
  that verify `marketing.module.view` + org scope and use the service-role client with explicit
  `organization_id` filtering and ownership checks (see IMPLEMENTATION_PLAN.md §4).
- `event.*` permissions, their seed migration, and the Customer & Growth Full Access extension are
  **deferred** to a future granular-access phase (see IMPLEMENTATION_PLAN.md).

### Deferred granular-access phase (future)
- The shared S&A framework (Group Policies, Full Access, destination navigation) remains on
  `issues-fixing-oct2` and is required only for the **future** `event.*` granular permissions and
  Full Access extension. Preferred sequence: complete/validate S&A → integrate to `staging` →
  update `event_management` → then add `event.*`. Do not merge the branch wholesale, do not create a
  parallel framework, and do not silently extend Full Access.

### Guardrails
- Admin functionality must not be activated without authorization (the parent gate).
- Do **not** move the Event Management module into `issues-fixing-oct2`.
- Do **not** merge, rebase, or cherry-pick anything as part of this planning work.

## Registration rules (approved)

- **Mandatory:** name and Malaysian mobile phone. **Optional:** email, cat name,
  cat breed (and current cat food where shown).
- **No** OTP or SMS verification in this version.
- Normalize phone numbers to canonical E.164 `+60` using existing helpers
  (`normalizePhoneE164`).
- Validate Malaysian mobile format, length, and supported prefixes on the server;
  client validation provides immediate feedback only.
- Reuse and inspect existing validation before proposing new logic.
- Do **not** infer the current telco from the prefix.
- Format validation does not establish ownership or active service.
- **One normalized phone per event** (`UNIQUE (event_id, phone_normalized)` on
  `event_contacts`; `phone_normalized` is `NOT NULL`).
- **First successful registration source is fixed, including booth:** booth → staff A
  stays booth; staff A → staff B stays staff A.
- Duplicate submissions never overwrite personal details, consent, the original QR
  source, or staff attribution.
- Describe metrics as **registrations**, not verified identities.

## Pending & proposed (see HANDOFF.md for the full list)

- **Deferred granular-access phase:** the five proposed `event.*` keys
  (`event.event.view`, `event.event.manage`, `event.registration.view`,
  `event.report.view`, `event.registration.export`), their `sa_permissions` seed migration, and the
  Customer & Growth Full Access extension (`sa_extend_standard_policy`, **not** auto-extended) are
  deferred to a future phase. These remain **recommendations, not approved grants**; registering a
  permission and granting it are different operations. They are not required before initial
  implementation (which uses the Marketing parent gate).
- The destination-based navigation layer (`nav-access.ts`) exists only on `issues-fixing-oct2` and is
  only needed for the future granular-access phase.
- Ellbow `brands` row / `logo_url` existence is a **technical verification** (read-only
  DB check), not a business decision; keep it pending if DB access is unavailable.

## Next action

The core business decisions (name + phone mandatory, no OTP, optional email/cat
fields, one phone per event, fixed first source including booth) are approved and
**implemented**. Initial implementation is complete and gated by the existing
Marketing parent access (`marketing.module.view`). The remaining user step is the
**manual migration step**: review the three `20261007_event0N_*.sql` files, then apply
them in order to staging/production and record the result in
`supabase/migrations/PRODUCTION_MIGRATION_STATUS.md`. The `event.*` permissions, seed
migration, and Full Access extension remain deferred to a future granular-access phase
(they depend on the shared S&A framework on `issues-fixing-oct2`).
