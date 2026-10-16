# System Logs

Settings → System → System Logs lets an authorized administrator investigate a problem another user hit and copy a
sanitized diagnostic report into Coder AI. Status (2026-10-07): code on branch `issues-fixing-oct2`, **migrations not
applied** anywhere.

## 1. Architecture

One contract (`app/src/lib/system-logs/contract.ts`) is shared by every reporter:

| Reporter | Entry point | Source | Identity |
|---|---|---|---|
| Browser, explicit (handled failures) | `reportClientError(error, ctx)` — `lib/system-logs/client.ts` | `browser` | session (server-derived) |
| Browser, uncaught | `SystemLogsBridge` (root layout) → `window` `error` / `unhandledrejection` | `browser` | session |
| Render errors | `app/error.tsx`, `app/global-error.tsx` → `ErrorFallback` | `browser` | session |
| Server, uncaught | `onRequestError` in `src/instrumentation.ts` → `reportRequestError` | `server` | session cookie, resolved server-side |
| Server, handled | `reportServerError({...})` — `lib/system-logs/server.ts` | `server` | caller's verified user |
| Background jobs | `cron-scheduler.ts` (5xx / timeout) + `reportWorkerFailure` | `worker` | none (system) |

Storage (`20261017100000_system_logs_foundation.sql`), service-role only:

* `system_log_groups` — one row per organization + environment + build + fingerprint: first/last seen, occurrence count,
  the last 20 references that were counted but not stored (rate-limited).
* `system_log_events` — stored occurrences (`kind = 'error'`, 30-day retention) and order activity (`kind = 'activity'`,
  written only by a database trigger).
* `system_log_ingest(jsonb)` — grouping, bounds (per group+actor 3/min, per group 20/min, per actor 30/min), browser ↔
  server correlation, idempotent retries.
* `system_log_list_errors`, `system_log_list_activity`, `system_log_event_detail`, `system_log_status`,
  `system_log_purge_expired`.

### Reused, not copied

| Source | Used for | How |
|---|---|---|
| `sa_access_change_log` (append-only, S&A functions) | Group Policy granted / revoked / restored / removed, account status changed / reactivated, lifecycle suspended / leaver, migration-mode changes, access requests | read at query time |
| `audit_logs` (server-written rows only) | administrative password reset: success / denied / failed | read at query time; generic `INSERT/UPDATE/DELETE` trigger rows are NOT shown |
| `orders` | create / submit / edit / approve / cancel / status | new AFTER trigger → `system_log_events` (orders had no audit trail) |
| Existing `console.*` logging | kept unchanged | the reporters do not override `console.error` |
| S&A diagnostics (`sa_authorization_decisions`, Parity, Simulator) | unchanged | System Logs links to them, does not duplicate them |
| Cron scheduler, worker lease, remote-DB guard | retention job + worker failure capture | `/api/cron/system-log-retention` |
| `readableOrganizations` / `authorizeOperation` | access + scope | `lib/system-logs/access.ts` |

### Correlation (one failure is counted once)

* Instrumented API routes return a server-generated `referenceId` (body) and `x-request-id` (header) on failure; the
  browser report carries it as `serverReferenceId` and is linked (`counted = false`, `duplicate_of`) instead of counted.
* Server-component render errors: the Next.js `digest` becomes `DIG-<digest>` on both the server report and the error
  boundary's report.
* Scheduler reports of a crashed worker route link to the route's own server report the same way.
* Linked browser rows are hidden from the list (no double listing) but an exact search by their reference finds them.
* Incoming `x-request-id` headers are **never** trusted (see §6 — there is no active middleware to overwrite them).

## 2. Coverage checklist (what is actually instrumented)

**Errors**

- [x] Page/render failures under the root layout (`app/error.tsx`) and in the root layout (`app/global-error.tsx`).
- [x] Uncaught browser errors and unhandled promise rejections (window listeners; resource-load errors, cross-origin
      `Script error.`, extension errors, `ResizeObserver` noise and HMR chatter are excluded).
- [x] Uncaught server failures: server component renders, route handlers, server actions (`onRequestError`).
- [x] Product Catalog: shop staff performance + consumer performance loads (browser + API, correlated). This is the
      current form of the old `loadShopUsers` path (now `loadShopStaffUsers` / `loadConsumerUsers`).
- [x] Order save / submit / edit failure (`CreateOrderView.saveOrder`) and order cancellation failure (`OrdersView`),
      including the existing "empty PostgREST error = connection problem" diagnostic.
- [x] Administrative password reset: auth-update failure and unexpected exceptions (diagnostic; the outcome stays in
      `audit_logs`).
- [x] Worker/cron runs answering 5xx or timing out (scheduler), and System Log retention failures.
- [ ] **Handled failures elsewhere are NOT captured** until a call site uses `reportClientError` / `reportServerError`.
      Most components catch errors and show a toast; global listeners never see those. Coverage grows per call site.
- [ ] API routes that catch and return 500 themselves (most routes) are not captured unless instrumented; only
      uncaught throws reach `onRequestError`.
- [ ] Per-job failures inside workers that the worker handles itself (e.g. one QR batch failing while the run returns
      200) are not captured.
- [ ] Anonymous/public pages (consumer scan, storefront, login): reports are refused (401) — no anonymous path exists.
- [ ] Middleware/edge runtime errors (`onRequestError` is wired for the Node.js runtime only).

**User Activity** (server records only; success/failure only where recorded)

| Action | Source | Outcomes shown |
|---|---|---|
| Create / submit / edit order, approve / cancel / status change | order trigger | success (committed). Failed saves roll back and are never activity; they may appear under Errors. |
| Grant / revoke / restore / remove Group Policy | `sa_access_change_log` | success (failures roll back, not recorded) |
| User activation / deactivation (account status, reactivation) | `sa_access_change_log` `identity.*` | success |
| Lifecycle suspension / leaver | `sa_access_change_log` | success |
| Administrative password reset | `audit_logs` | success, denied (`not_authorized`), failed (`target_protected`, `auth_update_failed`) |
| Migration-mode changes, access requests | `sa_access_change_log` | success |

Not covered: login/logout, profile edits, deletes, finance/HR/inventory postings, and any action before these sources
existed. Nothing historical is rebuilt. Activity rows carry no environment (localhost and staging share the database);
order rows show the browser-reported request origin as an observation only.

## 3. Security

* Permission **`platform.system_logs.view`** ("View System Logs", Platform & Settings → System), new; no equivalent
  existed (`security.audit.view`, `platform.notification_monitor.view`, `platform.settings.manage`,
  `platform.user.manage` were reviewed and rejected).
* SHADOW mode; compatibility audience and legacy evaluator: active central Super Admin (role level 1) only. Settings
  (≤ 40) and User Management administrators do not get it.
* Standard Group Policy **System Log Viewer** (`system-log-viewer`): exactly this permission, internal accounts, assigned
  to no one. **Platform & Settings Full Access is deliberately not extended** (`OUTSIDE_FULL_ACCESS` in
  `group-policies.ts`; `sa_standard_policy_drift()` lists it). Its description still begins "Every Platform & Settings
  permission"; extend it (owner-only `sa_extend_standard_policy`) if management wants platform administrators to read
  logs.
* To let System Log Viewer holders in, move the key to NEW_ENFORCED in Security & Access → Migration Modes after
  assigning the policy (Super Admins keep access through the compatibility role).
* Page `/settings/system/logs`, `GET /api/system-logs`, `/api/system-logs/[id]`, `/api/system-logs/access` decide via S&A;
  rows are limited to `sa_readable_organizations` (new mode) or every organization (legacy Super Admin). Tables and
  functions are service-role only.
* `POST /api/system-logs/report`: signed-in only; actor/organization/environment/source/kind/severity/fingerprint are
  server-derived (schema strips client values); ≤ 32 KB, ≤ 10 events, bounded strings/metadata; 30 events/min/user,
  120 req/min/IP; DB bounds per group/actor.
* Sanitized before storage and again when copying: passwords, tokens, JWTs, cookies, authorization headers, API keys,
  e-mails, phone/bank/card/IC numbers (9+ digits), URL query strings, request bodies, sensitive metadata keys; stack
  paths shortened. Record UUIDs, order numbers and dates are kept.
* `audit_logs` hardening: a RESTRICTIVE policy refuses the server-only actions (`PASSWORD_RESET`,
  `PASSWORD_RESET_FAILED`, `BULK_ENABLE_STOCK_CONFIGURATIONS`) from `authenticated`/`anon` — before this any browser
  session could insert them. `audit_action_valid` now allows `PASSWORD_RESET_FAILED` (the reset route's failure audits
  were being rejected).

## 4. Environment

Recorded from the server's runtime configuration (`lib/system-logs/environment.ts`):

1. `SYSTEM_LOG_ENVIRONMENT` (recommended on every deployment: `production`, `staging`, `development`),
2. else `NODE_ENV != production` → `local` (`next dev` against the shared staging DB is never "staging"),
3. else the app host: loopback → `local`, `stg`/`staging` → `staging`, `dev` → `development`, otherwise `production`.

The Errors tab defaults to the viewing server's environment, so localhost noise stays out of staging results.
Production writes to its own database; nothing connects production logs to staging. Build id: `NEXT_PUBLIC_APP_BUILD`
from `APP_BUILD_ID`, else `SOURCE_COMMIT`/`GIT_COMMIT_SHA` (12 chars), else `<version>-<UTC build minute>`; `dev` in
development.

## 5. SQL — run order (not applied)

1. `supabase/migrations/20261017100000_system_logs_foundation.sql` — independent of S&A; needs `public.users`,
   `public.orders`, `public.audit_logs`, `gen_random_uuid()`. Builds a small partial index on `audit_logs`
   (`created_at desc where action in reset actions`; writes to `audit_logs` wait while it builds) and re-validates
   `audit_action_valid` (one scan of `audit_logs`). Run it in a quiet window.
2. `supabase/migrations/20261017110000_sa_system_logs_view_permission.sql` — requires `20261005110000`,
   `20261009100000` (checked), apply after `20261016100000`.

Both are repeat-safe. Rollback statements are in each file's header. Until (1) is applied the app keeps working: the
reporters back off for 5 minutes on "function missing", the page shows "storage is not installed", the retention job
answers `RETENTION_NOT_INSTALLED`.

## 6. Scheduling and configuration

* Retention: `/api/cron/system-log-retention`, daily `41 3 * * *`, registered in the existing internal scheduler
  (`cron-scheduler.ts`); bounded batches of 5,000, at most 10 per run; deletes only `kind = 'error'` rows and idle
  groups older than 30 days. Order activity, `audit_logs` and `sa_access_change_log` retention are unchanged.
  It runs where the internal scheduler already runs (not on localhost: `DISABLE_INTERNAL_CRON_WORKERS=1`, remote-DB
  guard). No new scheduler and no disabled worker was enabled.
* Optional env: `SYSTEM_LOG_ENVIRONMENT`, `APP_BUILD_ID`.
* **Pre-existing finding:** `app/middleware.ts` is not loaded by Next.js (the app uses `src/app`, so only
  `src/middleware.ts` would be). That is why request ids are generated by route handlers, not middleware.

## 7. Delivery limits (honest)

Browser reports are best effort: ≤ 20 queued, 3 retries with back-off for network/5xx, 15-minute expiry, a
`sessionStorage` copy for a reload. Nothing is delivered while offline, after the tab closes before a flush, while the
server is down, or when signed out. Rate-limited occurrences are counted but not stored (their references stay on the
group). System Logs does not "capture every issue".

## 8. Copying a report to Coder AI

Settings → System → System Logs → click a row → **Copy diagnostic report**. The clipboard text contains environment,
build, time, reference/correlation/server references, module/action/page/API/status, category/code, message, grouped
counts, browser/device, sanitized details and stack, and related events linked by recorded ids. It contains no user
identity, organization, request bodies, credentials or query strings. A user can quote the reference shown in their
error toast ("Reference: ERR-…"); search for it in the Errors tab.

## 9. Verification

* `supabase/tests/security/system_logs/run.sh <disposable sa_prof_test* DB>` — real S&A migrations + both System Logs
  migrations (each applied twice) on a throwaway PostgreSQL 17; privileges, grouping, bounds, correlation,
  environment/org separation, validation, scoped reads, pagination, order trigger (committed / rolled back / logging
  failure does not block the order), audit_logs forgery refusal, activity read model, retention preserving audit
  sources, permission/policy/evaluation.
* Vitest: `src/lib/system-logs/*`, `src/app/api/system-logs/**`, `src/components/system-logs/*`,
  `src/lib/security-access/system-logs-catalog.test.ts`, `src/app/api/cron/system-log-retention`,
  `src/lib/cron-scheduler.system-logs.test.ts`, `src/app/api/users/reset-password/route.system-logs.test.tsx`,
  `src/modules/settings/settingsNav.system-logs.test.ts`.
* New test files and this document are matched by `.gitignore` (`*.test.ts`, `**/tests/**`, `*.md`); add with `git add -f`.
