# Navigation access, HR My Workspace and the staff organization chart

Hiding navigation is not authorization. Every route, API, download and mutation decides again on the server. This page
describes what decides what is *shown*, and the employee-facing HR entry.

## One destination table

`app/src/lib/security-access/nav-access.ts` maps every HR, Customer & Growth and RoadTour destination to the Security &
Access permissions that unlock it. It drives:

| Surface | Reads it through |
|---|---|
| Server page guards (HR pages, `/crm`, `/marketing`, `/catalog`, `/ecommerce`, `/loyalty`, `/customer-growth`, `/roadtour`) | `resolveDestinationAccess` (`lib/server/nav-access.ts`) |
| Sidebar entries, HR / Customer & Growth / RoadTour top navigation, landing cards, HR edit controls | `GET /api/security-access/me/navigation` → `useNavAccess()` |
| Employee APIs (`/api/hr/self-service/me`, `/payslips`), staff chart API | `resolveDestinationAccess` |

The decision is `authorizeOperation` in each permission's **current migration mode** (LEGACY_ENFORCED / SHADOW: the
module's historical rule decides; NEW_ENFORCED / LEGACY_RETIRED: S&A alone decides; a legacy ALLOW never overrides an S&A
DENY). The historical rules are kept as the legacy evaluators in `legacyRuleFor`. No mode is changed anywhere.

* Administrative HR destinations need the module entry (`hr.module.view`) **and** their own permission
  (e.g. `hr.employee.view`, `hr.leave.approve`, `hr.payroll.view`, `hr.settings.manage`).
* Employee destinations (`hr/my-workspace`) need `hr.self_service.use` on the person's **own record** (own_record scope).
* A parent entry (HR, Customer & Growth, a RoadTour group) appears only when at least one child destination is accessible.
* A route that is not in the table is denied, not open.

### Shared permissions (explicit)

`product.catalog.view` is held by **Supply Chain Full Access** and is also the permission of the Customer & Growth
*Product Catalog* child. A Supply Chain Full Access user therefore sees Customer & Growth with the Product Catalog child
only; CRM, Marketing, Loyalty, E-commerce and RoadTour need their own permissions. Where CRM / Marketing / Catalog are
still on SHADOW, their historical HQ + role-level rule (the *legacy evaluator*) still decides until management enforces them.

## States

| State | Meaning | UI |
|---|---|---|
| allowed | S&A decision ALLOW | page / entry shown |
| denied | S&A decision DENY | shared `AccessState` ("You don't have access to this page.") |
| unavailable | the permission check failed (service/network) | shared `AccessState` "couldn't check your access" + retry; nothing gated shown; never an allow |
| signed_out | login expired | redirect to `/login` (server) / "session expired" |
| employee pending | no verified employee link, or HR onboarding not complete | "Your employee setup is pending. Contact HR." |

Technical detail (role level, permission key, engine reason) stays in server logs (`[hr-access]`) and the S&A decision
log, never in the page.

## Cache and identity

The snapshot is bound to the verified user **and** organization. A different user or organization never inherits it;
a response naming another identity is discarded. It is re-read on every shell mount (each page navigation), when the tab
regains focus after 60 s, and after any successful S&A admin change (`callApi` → `notifyNavAccessChanged`). The one
in-memory entry only avoids menu flicker; it never affects what the server allows.

## HR My Workspace

`/hr` opens the administrative landing only for people holding `hr.module.view`; an Employee-Self-Service-only person
lands on **My Workspace** (`/hr/my-workspace`): My Employment (own record via `/api/hr/self-service/me`), My Attendance,
My Leave, My Payslips (the existing employee screens under `/hr/mobile/*`) and, with the staff directory permission, the
Organization Chart. The employee is always the authenticated account; the organization is its own profile's; the employee
link is never matched by email/phone and nothing is created when it is missing.

Payslips come from `/api/hr/self-service/payslips`: own items of **approved/posted** payroll runs only.

## Staff organization chart

Reuses the existing read-only directory permission `hr.employee.view_internal` (no new permission, no migration). The
server (`lib/server/hr/staff-org-chart.ts`) selects only: display name, job title, department, manager link; ids are
replaced by per-response opaque keys. Own organization only, active employees whose HR onboarding is complete. The
administrative chart stays behind `hr.module.view` + `hr.employee.view`.
