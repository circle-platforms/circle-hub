# Keep missing command-tree sources unknown

The template-gap index consumer currently treats an entry with `command_identities` but no `command_tree_root` as a
complete command set. Its signature and identity may agree with each other while the source tree for the locked
projection is not declared. This can produce a coverage conclusion for an unverified command universe.

Require the source tree field when counting a case as having complete command identities. A missing or null source is
legacy/unknown, names `command_tree_root` as a missing fact and provides the existing re-read/reproduction exit; a
mismatched explicit source stays refused. Keep fully declared identities and an explicitly empty command list working
as before. Reject a malformed non-null source digest even when the identity list is empty, so an invalid source cannot
be used to prove an empty command set. Update synthetic fixture producers and regenerate their owned samples, without weakening old assertions.
Patch the package version and resign with its own tool. Allowed paths: this page and `packs/workflow/template-gap/**`.
Run affected tests and relevant acceptance tests before merge-locked.sh.
