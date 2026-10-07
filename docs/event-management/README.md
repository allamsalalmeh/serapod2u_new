# Event Management Module — Planning Documents

> **Status: Assessment only. Development has NOT started.**

This folder is the entry point for the next coder working on the Event
Management module. It records what was verified in the repository, what is
still undecided, and what the next implementation step is.

## Branch and base

| Item | Value |
|---|---|
| Branch | `event_management` |
| Base branch | `origin/staging` |
| Base commit | `9e27404d` (`fix(orders): atomic order save + index order_items FK probes`) |
| Created from | a stash of the `issues-fixing-oct2` working tree (326 uncommitted changes, preserved in `stash@{0}`) |

Do **not** push, merge, deploy, or run migrations from this branch. The base
was chosen as the clean integration branch so the new module does not sweep in
the in-flight Security & Access / finance / HR work that lives on
`issues-fixing-oct2` (14 unpushed commits + 326 uncommitted changes at the time
of writing).

## Reading order

1. `README.md` — this file (status, scope, next action).
2. `ASSESSMENT.md` — verified repository evidence, reusable pieces, risks, and
   the Ellbow asset / migration-naming findings.
3. `IMPLEMENTATION_PLAN.md` — proposed folder/route layout, data model,
   permission matrix, API design, and phased plan.
4. `HANDOFF.md` — decisions that still need answers, approved vs proposed,
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
  Policies, Group Policies and Migration Modes; sidebar visibility, page access
  and API authorization use the same `event.*` keys + organization scope.

**Explicitly out of scope** (do not add): ticketing, payments, prizes, loyalty
points, sample inventory, automated broadcasts, budgeting.

## Pending decisions (see HANDOFF.md for the full list)

- Which contact fields are required vs optional (not yet finalised).
- Whether a duplicate phone per event is the right dedupe rule.
- Whether the first valid staff attribution stays fixed.
- Exact permission key names (`event.*` 3-part keys proposed: `event.event.view`,
  `event.event.manage`, `event.registration.view`, `event.report.view`,
  `event.registration.export`), plus whether to extend Customer & Growth Full
  Access via `sa_extend_standard_policy` (it is **not** auto-extended).
- Whether to base the S&A navigation work on the `nav-access.ts` layer that
  only exists on `issues-fixing-oct2` (see ASSESSMENT.md § "Security & Access").

## Next action

Read `HANDOFF.md`, answer the open questions, then start Phase 1a of
`IMPLEMENTATION_PLAN.md` (data model + migrations) — but only after the user
reviews these findings.
