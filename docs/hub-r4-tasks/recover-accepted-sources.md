# Recover a read reply when a source of the root was accepted despite credential-like findings

On the deployed Hub a read recovery (`get_nodes` with `call_query` and the original trace) answered "暂存的原回答未能按当前权限或来源状态核对" for every tree page, even a 35-node page read seconds earlier. The recheck (`recoverySourcesReadable`) required every source of the root to be clean (`acceptance` absent, no scan findings). A real root holds manuals and documents whose example passwords were accepted by an administrator (a recorded acceptance decision lifts them to model-readable), so no real root could ever be recovered.

Change: a source passes the recheck when it is model-readable now and either an acceptance in force lifts its findings or its scan is clean and complete. Held sources (tier retain-only), truncated scans, bytes that no longer hash to the source and sources the reader cannot read still fail it.

Allowed paths: `hub/knowledge/recovery-sources.ts`, `hub/knowledge/recovery-sources.test.ts`, this page.

Verification: `npx tsc --noEmit`, the recovery test files of hub/knowledge and hub/server; on the deployed Hub the experiment is a `get_nodes` on a real root followed by `call_query` with the same arguments and trace.
