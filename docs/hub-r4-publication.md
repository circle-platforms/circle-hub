# Public R4 snapshot

This branch starts at the public `origin/main` baseline and imports the final R4 tree as one signed-off snapshot.
The local integration history is not included. No integration branch, gateway repository, tag, settings or deployment
is published by this change. The owner separately authorized carrying the final R4 CI workflow so its commands match the
new package scripts; no deployment workflow or GitHub setting changes. The old task-and-approval server is retired; this is not an in-place database upgrade.

## Public-tree preparation

- Replace the product families, package id, paths, declarations, build examples and tests with synthetic FAMX/FAMY names.
  Replace legacy private project names and OEM/platform names with synthetic tokens. Keep runtime parsing structural.
- Increment each affected published package version, regenerate authored samples and content identities, and refresh
  manifests through the package's own tooling. Regenerate contracts through `tools/gen-contracts.ts`.
- Construct synthetic credential-shaped negative-test values at runtime; no real credentials are substituted or hidden.
  Keep the original byte-level scanner/security assertions. Replace synthetic user-home paths with neutral fixture roots.
- Store two synthetic NUL-bearing manuals as escaped text and restore the same bytes through their fixture reader.
- Keep `foundation/` and `references/` byte-for-byte unchanged. Source ids used by archive verification come from the
  manifest's structural declaration; the two placements, all blob digests, complete Git trees and closure remain checked.

## Scanning

The full staged tree and the new commit's patch are scanned with `git grep`, custom regular expressions and
`gitleaks 8.30.1`. The directory scan includes the immutable archives and has no added allowlist. Credentials are
redacted in scanner reports. The check covers brand/OEM names, protected release/build forms, machine paths,
IPv4/IPv6/hosts/URLs/ports, email/account candidates, credential/private-key/encoded-data shapes, logs/dumps,
binary files and files larger than 1 MiB. Scanner artifacts remain outside Git; no raw findings or logs are published.

The first gitleaks pass reported 24 synthetic fixture/golden-value literals; these are constructed at runtime without
changing their test values. The final directory and commit scans must report zero leaks before push. Custom candidates
are reviewed by context: SHA/content identities and dependency integrity values are not encrypted credentials;
loopback/bind guards, masks and version numbers are not private deployment addresses; reserved example domains and
example mailboxes are synthetic. Protocol vocabulary is retained. The pinned third-party engine's illustrative user path
is upstream source, not a local operator path. A Chinese substring match occurs inside the phrase for system trust store.

The immutable archives retain their pre-existing names, addresses, paths, hashes and binary assets; they are scanned and
reported without editing. They contain 21 binary files. The active public tree contains no binary file or file larger
than 1 MiB; its largest file is a generated JSON schema/tool artifact below that limit. No new log or session dump is added.
No claim is made that regular expressions can identify every possible undisclosed organization or identifier. No real
system inventory, personal profile, environment file or credential store is accessed to make that claim.

## Validation

The integration source snapshot passed: typecheck, 132 generated files, unit 7622 passed / 1 skipped / 0 failed,
docs 223 passed, acceptance 109 passed and reference tests 7 passed. Public-tree validation is recorded separately
in the pull request after anonymization and regeneration. A skipped test is not counted as a pass.

## Follow-up integrity correction

Opaque distribution metadata is not a business label. The first public preparation accidentally replaced character
substrings inside dependency SRI values; clean CI installation correctly refused those bytes. Restore the published
lockfile metadata without changing dependency declarations, and verify it with a fresh `npm ci`. Never rewrite
dependency integrity values, content identities or signatures to remove coincidental identifier-shaped substrings.
Resolve those scanner candidates against their declared structural fields and authoritative bytes. No integrity
check is disabled or bypassed.

A previously unmerged synthetic seeding diagnostic is retained with tests for success, producer refusal and cleanup
failures. Its HTTP server, temporary database and directories are released on all acquired-resource exit paths;
this adds no production source parser or real-system access.
