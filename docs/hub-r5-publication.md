# Public R5 synchronization

Synchronize the owner-selected integration tree onto public main without importing its local history.
Keep the FAMX/FAMY package, family, platform and project substitutions established for the R4 publication.
The deployment checkout and other active worktrees stay unchanged.

## Included changes

- Preserve declared sibling-switch inverses and the router/client/server trigger capability set.
- Add declared text-table bed parsing, target-device baseline narrowing and explicit configuration baseline handling.
- Add raw echo capture, administrator-recorded baselines, bounded before/after comparison and recovery evidence.
- Carry the current workflow declarations and refresh changed public pack identities: famx 1.7.31,
  case-compile 3.6.1 and test-bed 1.2.8. Regenerate samples, contracts and manifests with their owning tools.

The public-main fixes for matched-signature inverse ambiguity, exact explicit trigger sets, synthetic CI fixtures,
temporary-database cleanup and complete test partitioning remain in place. This synchronization does not revert
already-published checks or remove their regression tests. No additional design remediation is included.

## Publication boundary

The branch starts at GitHub main in a separate publication clone and contains only new signed-off public commits.
Do not push private integration ancestry. Preserve immutable foundation/reference bytes and opaque dependency SRI
metadata. Package content changes receive fresh versions and manifests rather than reusing a published identity.

Run types, generated-contract consistency, unit partitions, documentation checks, temporary-PostgreSQL acceptance
and reference integrity. Record exact local and Linux CI counts separately in the pull request; skips are not passes.
Use concurrency at most two for each test invocation. The required CI result must be for the exact branch head.

Scan the entire tracked tree and each proposed commit diff with git grep, contextual regular expressions and
archive-aware gitleaks. Report immutable-archive matches without changing bytes. Keep scan artifacts outside Git,
with secrets redacted. Public dependency metadata, digests, protocol words, reserved examples and negative-test
fixtures require contextual review rather than arbitrary substitution. No allowlist or security assertion is weakened.

No private enterprise name inventory or archive-image OCR is claimed. No gateway push, deployment, tag, repository
setting change, real model, enterprise-system call or device run is part of this update.
