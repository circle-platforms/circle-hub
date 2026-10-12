---
name: knowledge-consolidation
description: Consolidate explicitly shared facts, practices and corrections as private evidence-backed candidates
---

Read inputs.json. Use knowledge.shared_fragments to collect only the caller's explicitly shared source fragments. Preserve each original quote, tool return and evidence reference. Never read another home, a conversation store or unshared session files.

Run scripts/normalize.ts on the collected structured fragments. It validates and deduplicates facts, practices and corrections; it does not judge unstructured text or declare a statement true. Submit each candidate with knowledge.claim_submit using the original evidence. Keep the returned record IDs, conflicts and unresolved elements in out/consolidation.json.

Every result starts as personal consolidated knowledge. Do not publish a snapshot, promote a candidate, overwrite product knowledge or resolve a conflict merely because the model agrees. Team promotion requires product-source verification or separate human review and sharing consent. Unknown formats remain unmapped.
