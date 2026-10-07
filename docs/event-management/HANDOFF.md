# Event Management — Handoff

## Read these first (in order)

1. `README.md` — status, branch/base, scope.
2. `ASSESSMENT.md` — verified evidence, reusable pieces, risks, Ellbow assets, migration naming.
3. `IMPLEMENTATION_PLAN.md` — folder/route layout, data model, permissions, API, phases, tests.
4. This file — decisions, approved vs proposed, next step, prompt.

Do not start implementation until the user reviews these findings and answers the open questions.

---

## Decisions still requiring user answers (blocking)

1. **Contact fields required vs optional** — Name / Phone / Email / Cat name / Cat breed /
   current cat food. Which are required on the public form?
2. **Duplicate rule** — confirm "one normalized phone per event" (`unique(event_id, phone_normalized)`),
   or allow email-only / name-only dedupe.
3. **First staff attribution** — confirm it stays fixed once set (a later resubmission never
   overwrites the first valid staff).
4. **Permission naming** — confirm the proposed `event.*` keys (`event.view`, `event.manage`,
   `event.registration.view`, `event.export`) vs. folding under `customer.*`.
5. **S&A base dependency** — Event Management needs to know whether to build sidebar/visibility on
   the **existing** `authorizeOperation` + `MODULE_TAXONOMY` (available on this branch) or to depend
   on the newer `nav-access.ts` / `group-policies.ts` layer that only exists on `issues-fixing-oct2`.
   Merging that entire branch is out of scope.
6. **Ellbow brand link** — confirm whether an Ellbow `brands` row (and `logo_url`) exists in the
   database; the checkout cannot read live DB data.

## Approved (confirmed by the user this round)

- Base branch: `origin/staging` @ `9e27404d`; new branch `event_management`.
- Place Event Management under **Customer & Growth → Marketing**, directly below **Road Tour**, in
  both the overview card and the top dropdown.
- Group S&A permissions under **Customer & Growth → Event Management** consistently in Policies,
  Group Policies and Migration Modes.
- Sidebar visibility, page access and server/API authorization use consistent permissions + org scope.
- Public QR registration is separate from staff/admin access and must **not** require an admin Group
  Policy.
- Do **not** silently modify existing grants (e.g. `customer-growth-full-access`).
- This round is assessment + documentation only; no implementation.

## Proposed (not yet approved)

- Folder layout `app/src/modules/event-management/` (not `app/src/features/`).
- `event.*` permission namespace and the permission matrix in IMPLEMENTATION_PLAN.md.
- Data model (6 tables) and the `event01`–`event04` migration sequence.
- Duplicate/attribution rules in IMPLEMENTATION_PLAN.md §5.

## What may start next (after review)

- **Phase 1 only**: data model + migrations + `event.*` permission seeding + `modules.ts` event area.
  This is low-risk and unblocks everything else.

## What remains blocked

- Public registration form content until decision 1 is answered.
- Sidebar/visibility wiring until decision 5 is answered.
- New/returning identity semantics until decision 2 (and the identity-link design) is confirmed.

## Update these documents as implementation progresses

- Move a decision from "pending" to "approved" in this file when the user confirms it.
- Mark ASSESSMENT.md findings that change (e.g. once `nav-access.ts` is available on the base).
- Tick off phases and record acceptance results in IMPLEMENTATION_PLAN.md.
- Update `README.md` "Status" when development begins.
- Update `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md` in the same commit as each migration.

---

## Ready-to-copy prompt for the next session

```
You are working on the `event_management` branch (base origin/staging @ 9e27404d) of Serapod2U.
First read docs/event-management/README.md, ASSESSMENT.md, IMPLEMENTATION_PLAN.md, and HANDOFF.md.
Implement only Phase 1 (data model + migrations + event.* permission seeding + modules.ts event area).
Follow the repository conventions recorded in those docs: app/src/modules/event-management/,
server-side QR token resolution, E.164 phone normalization via app/src/utils/phone.ts,
authorizeOperation/guardUserOperation for org-scoped authorization, and the manual migration
workflow tracked in supabase/migrations/PRODUCTION_MIGRATION_STATUS.md. Do not push, merge, deploy,
or run migrations yourself — I run them manually. Write Vitest tests colocated with source. Show me
the migration files and the diff before I apply anything.
```
