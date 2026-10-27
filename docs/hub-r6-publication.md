# Public R6 synchronization

Synchronize the owner-selected integration tree onto public main without importing its local history.
Keep the FAMX/FAMY package, family, platform and project substitutions established for the R4 and R5 publications.
The deployment checkout and other active worktrees stay unchanged.

## Included changes

- Generic skill packs for company artifact formats (mind map, workbook, command-tree XML, HTML) with run-pinned digests,
  and on-demand fragment parsing (`locate`) so real-size documents stay within the sandbox output budget. Source access is
  rechecked at every use, batches are bounded and halved on output limits, and the document cache has a byte budget.
- Circle operation capture and consolidation: observation, procedure and pitfall records enter the feeding layer at
  declaration grade; declaration-grade records are refused as grounds of another submission; an administrator can retract
  an entry (`circle-hub knowledge retract`) without rewriting it.
- The case-compilation block model, independent recomposition, and criterion review by a non-author account.
- Dispatch: bed-hold comparison by probe intersection with an administrator clear (`bed hold clear`), a single live
  observation per job (fixes a double-driver false hold), post-run bed snapshots before the lease ends, and block-address
  validation.
- Source reads: the `source-read` generic pack; a system-pack declared extension-to-media-type mapping (receipts keep the
  server's media type, originals record the effective one); the PLM build list envelope projection.
- Runs and read views resolve a build to the same root (seedling pointer first, then the build root).
- Read views disclose withdrawn rule versions; shared drafts can be read-only review predecessors; an administrator
  command lists stored runs; resource origin updates clear stale plaintext allowances.
- Synthetic acceptance for scenarios T1 to T9 and their coverage map.

## Known open failures

- Scenario 28 of the acceptance suite has two failing tests where `sandbox-exec` is available (#37). They fail identically
  in the previous publication (#27) and are skipped on Linux CI.
- One operation-capture lock-recovery unit test failed once in a complete partition and passed in every other run (#38).
- The snapshot carries these as they are. No assertion was weakened, deleted or skipped to hide them.

## Not included

- Local integration records (task pages and progress notes under `docs/`), real-environment scripts, and anything that
  touches a real system or device. Three documentation lines that the documentation checks require are carried (the
  `client_captured` provenance value in both generic-model pages and one coverage path), and so are the independent
  quotation checks under `scripts/real/gold` and their tests, whose assertions now follow the verbatim-quote contract.
- Work that is still open: see the linked issues (operation device/lease binding is a documented work-in-progress with
  known blockers; the core-to-product-pack directory import is a design decision).

## Publication boundary

The branch starts at GitHub main in a separate publication clone and contains only new signed-off public commits.
Do not push private integration ancestry. Preserve immutable foundation/reference bytes and opaque dependency SRI
metadata. Package content changes receive fresh versions and manifests rather than reusing a published identity.

Run types, generated-contract consistency, unit partitions, documentation checks, temporary-PostgreSQL acceptance
and reference integrity. Record exact local and CI counts separately in the pull request; skips are not passes.
Use concurrency at most two for each test invocation. The required CI result must be for the exact branch head.

Scan the entire tracked tree and each proposed commit diff with git grep, contextual regular expressions and
archive-aware gitleaks. Report immutable-archive matches without changing bytes. Keep scan artifacts outside Git,
with secrets redacted. No allowlist or security assertion is weakened.

No gateway push, deployment, tag, repository setting change, real model, enterprise-system call or device run is part
of this update.
