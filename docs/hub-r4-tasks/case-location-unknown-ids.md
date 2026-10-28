# Preserve undeclared identifier kinds in case location

The case-location skill still describes retired misspelling and prose-marker rules. Its expected-source warning also
says that the one readable record decides the type of an untyped number, although neither source existence nor a
missing candidate proves what the author meant. This can mislead a real Circle session. Align the skill and workflow
description with the existing exact whole-field grammar, and make the warning preserve the undeclared kind with an
author-declaration or quoted-judgment exit. Keep the existing two candidate reads and declared-range behavior.

This explicitly corrects the old warning-text contract: the one existing assertion that requires “the existing one
decides the kind” must change to assert the new unknown and exit. All other old assertions stay unchanged. Add a
synthetic regression for the old warning and for prose, exact fields and declared ranges. Update README, patch version
and the generated manifest using the pack's tool. Allowed paths: this task page and `packs/workflow/case-location/**`.
Run the affected-test tool, package publication tests and relevant acceptance tests before merge-locked.sh.
