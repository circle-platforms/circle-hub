# Avoid an unrelated product sync in operation acceptance

Source: the sixth local brief, with the integrator assigning one preparation change at a time after baseline measurement.

Allowed paths are `tests/acceptance/support/operation-acceptance.ts` and this task page.

Manual operation scenarios use the single-name product's root. Prepare only that product instead of also syncing the two-name product. Other operation scenarios keep syncing the two-name product. Each scenario retains its own Hub, database, scratch capture session and every existing assertion.

The only permitted test file is `tests/acceptance/44-r5-t5-1-webui.test.ts`. The integrator scheduled one unchanged run at C4 commit `31f53fb2f0`, followed by one changed run in this task's worktree. Both used `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test tests/acceptance/44-r5-t5-1-webui.test.ts`, without inherited shared PostgreSQL variables.

| Measurement | Before | After |
|---|---:|---:|
| External wall time, seconds | 160.418510 | 56.403563 |
| Node test duration, seconds | 160.382594 | 56.379062 |
| Tests passed / failed / skipped | 3 / 0 / 0 | 3 / 0 / 0 |
| Exit status | 0 | 0 |

The original logs, exit statuses and wall times are saved as `operation-44-before.*` and `operation-44-after.*` in the external test-speed report directory. All three scenarios and assertions are unchanged. This is one paired measurement, not evidence of whole-suite performance: the unchanged second scenario also varied from 51.337552 to 20.106387 seconds, so the full wall-time difference cannot be attributed to this change alone. The removed work is exactly the two unrelated two-name-product syncs in the manual scenarios.

No type check, complete acceptance run or full regression was run for this change. The integration branch's final full regression belongs to the integrator.
