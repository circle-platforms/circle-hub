# Align template-gap guidance with the six Hub tools

The template-gap skill refers to the retired `get_workflow` tool and omits `command_tree_root` from its index example,
although the package's own index repair text requires that field to bind command identities to their source tree. A real
Circle session cannot follow that guidance. Use `list_task_packs` for the published requirements and `start_run` plus
its run record for the slot schema; include `command_tree_root` in both index examples. State that feeding can remain
pending, and report missing evidence to a maintainer without naming a person.

This is guidance only; do not change classification or coverage behavior. Add a synthetic documentation regression,
patch the pack version and resign with its own tool. The existing tests' version literals must follow the new package
version; their other assertions stay unchanged. Allowed paths: this page and `packs/workflow/template-gap/**`.
Run affected tests and the relevant acceptance tests before merge-locked.sh.
