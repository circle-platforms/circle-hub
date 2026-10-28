# Task: Carry the public R7 CI fixes back into the integration tree

The public R7 branch fixed an exited-process observation race in the Linux sandbox and moved a test-only feeding fixture out of the production-code scan. The integration tree predates those fixes. Carry the same behavior and test placement back before a future deployment; do not change the CI workflow or weaken existing assertions.

Scope: `hub/rules/sandbox/resident.ts`, `hub/rules/sandbox/resident-linux.test.ts`, `hub/platform/key-transfer.test.ts`, the feeding-bounds test fixture and its imports, and this task page. Use only synthetic test data. Keep generated contracts and published package content unchanged.

Run the risk-based checks and targeted Linux and macOS tests. The wide sandbox change also participates in the complete pre-deployment verification.
