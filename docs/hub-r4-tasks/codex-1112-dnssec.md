# Prepare one executor action for deployment

## Scope

This task may change only this page. Private configuration copies and rollout instructions stay outside Git. It does not query the deployed Hub, change its configuration, access devices or inspect a Circle home.

## Findings

An enabled `execute` method does not enable every action in its registry. The selected action is disabled in the original registry, and the environment profile keeps `execute` outside `allowed`.

`execute_registry` has no supported parameter role in `packs/workflow/case-compile/tables/dispatch-roles.json`. Its unsplit action cell also needs action-specific validation and encoding before it can be opened. Assigning the argument an arbitrary text role would bypass that missing check.

A changed original registry needs a newly exported original contract and its matching identity. Editing the preserved original digest or presenting an owner decision as a device certification receipt would not establish those facts.

## Handoff

The private handoff lists the exact configuration pointers, desired changes and CLI order. A warrant update is independent of opening an action. The rollout must stop at the action step until its original contract and package support are available.

No runtime or test file changed; no test command ran for this task.
