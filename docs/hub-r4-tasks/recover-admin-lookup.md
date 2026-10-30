# Let a read recovery check the root's raw captures without a standing admin

On the deployed Hub the recovery of a tree page still answered "暂存的原回答未能按当前权限或来源状态核对" after sources accepted despite credential-like findings were allowed. The recheck reads the root's raw captures as an administrator and took that administrator from the knowledge context, which a deployed Hub leaves empty (every sync names its own admin); only the tests set one. So the recheck could never pass in production.

Change: when the knowledge context holds no admin, the recheck takes an enabled administrator account as stored now; with none enabled, or no way to list accounts, it cannot be checked and recovery stays unavailable. A test sets the context admin to null in the live recovery scenario so the production shape is covered.

Allowed paths: `hub/knowledge/recovery-sources.ts`, `hub/knowledge/recovery-sources.test.ts`, `hub/server/recover-read-live.test.ts`, this page.

Verification: `npx tsc --noEmit`, the recovery tests of hub/knowledge and hub/server; on the deployed Hub, a `get_nodes` read followed by `call_query` with the same arguments and trace.
