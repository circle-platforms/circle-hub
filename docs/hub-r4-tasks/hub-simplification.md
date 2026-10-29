# Reduce repeated work in Hub

Decision 81 makes simplification the next priority. The owner asked for the staged plan to be implemented: first inventory and measure the mechanisms, then reduce repeated work, and finally revisit the real workflows. Decision 80 governs verification.

The inventory and concrete decisions are in `docs/hub-r4-research/hub-simplification.md`. Removing or deferring an existing mechanism and its tests, or changing the model or AGENTS instructions, needs the owner's explicit decision on the concrete list. Changes that preserve existing behavior may proceed independently. No historical result is rewritten.

This first worktree covers the inventory, this task page, and the resolver's repeated source reads in `hub/runs/engine/exact.ts` with synthetic tests alongside it. A prefetched reference still checks current access before use; revoked access and withheld credentials must never be disclosed from a cache. Other batches get their own task pages and worktrees after the relevant decisions.

Run the affected checks with the CPU-adaptive scheduler (decision 83). Do not access production systems or credentials for development. Deployment, a real-device window and a public push remain separate owner decisions.
