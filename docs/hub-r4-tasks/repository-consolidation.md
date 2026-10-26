# Consolidate repository work without publishing private history

Owner scope covers local Hub worktrees, branches, unfinished code and GitHub PRs. Preserve the deployment checkout,
active validation directories and the gateway repository. Inventories and private history bundles stay outside Git.

Allowed public changes include dependency integrity restoration, CI execution budgets, synthetic diagnostics,
the contract/product/workflow inverse-alternative changes and their generated files, manifests and tests.

The public branch starts from public main and contains a compressed snapshot plus focused follow-ups. No local
integration ancestry is pushed. Private unique work is bundled and verified before its refs are removed; obsolete
PRs are commented and closed rather than reviving the retired HTTP/worker architecture.

CI's unit job was cancelled at its 15-minute suite boundary while still progressing. Fix the invocation at two
workers and give the complete suite a bounded 30-minute job budget, matching its current size; retain every test,
per-test timeout, failure exit and nonempty-test/skip summary. Merge only after the exact public head passes CI.
