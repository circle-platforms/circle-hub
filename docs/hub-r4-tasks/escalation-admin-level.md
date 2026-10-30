# Stop escalating an escalation that already names an active administrator

Since 2026-10-24 maintenance escalated every expired unanswered request to a named administrator, and an expired
escalation advanced in the same way. Each unanswered request therefore added one escalation a day, all to the same
administrator with the same next action. On the copy of the production data of 2026-10-30, 17,807 of 21,855 requests were
such escalations, about 3,300 to 3,900 new ones a day, and every request sweep of every maintenance pass reads them all.
The owner chose to stop at the administrator level (decision 101).

Change:

- `escalateOverdueRequests` (hub/runs/engine/maintenance.ts): an expired request whose source is another request (an
  escalation) and whose audience is an active administrator is not escalated again. It stays in the run listings'
  `overdue_requests` under its own deadline. When that administrator is disabled or no longer an administrator, the
  escalation advances once to the first active administrator, as before. Originals still escalate once; answers still
  propagate through the escalation references; records already written are untouched.
- The 2026-10-24 test now asserts that the escalation of an active administrator is not escalated again, stays overdue
  under its own deadline, and advances after that administrator is disabled.

Allowed paths: `hub/runs/engine/maintenance.ts`, `hub/runs/engine/overdue-requests.test.ts`, `hub/runs/engine/README.md`,
`docs/hub-r4-progress.md` (decision 101 and the deferred list), this page.

Verification: `npx tsc --noEmit`; `node --test hub/runs/engine/overdue-requests.test.ts hub/runs/engine/maintenance-pass.test.ts`;
`affected-tests.py --run`; the full check before the next deployment.
