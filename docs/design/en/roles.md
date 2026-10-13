# Roles and scope

Two kinds of principal: a person, and a service client. A service client is a machine identity. It has only a scope string (for example `jumphost:run`), and it has no role.

## Three roles, granted by scope

A person's role is granted by scope: **administrator**, **member**, **guest**. An administrator of the root scope is the hub administrator. A scoped role is the only source of a person's permissions; the action strings scattered today (`assets.approve`, `decisions.approve`, `cases.execute`…) are folded into three presets, in a single migration; the interface shows only the role. Presets are data, and they can be customized later.

| What they can do | Administrator | Member | Guest |
|---|---|---|---|
| read materials, Evidence, the Registry, and task status in this scope | ✓ | ✓ | ✓ |
| hand over, run (through the Enforcement chain, no approval), respond to one's own task | ✓ | ✓ | — |
| push a skill package, upload an original, register a resource, create a bot | ✓ (Change set) | ✓ (Change set, an administrator must approve) | — |
| approve a Change set | ✓, not one's own | — | — |
| people, roles, scope policy | ✓ (Change set) | — | — |
| worker, runtime profile, service client | ✓ | — | — |

The existing targets / readers still limit which specific resources and sources are visible; the root administrator manages roles and scopes, and does not automatically inherit the reading of materials in a child scope.

## The two-person rule

The scope policy `twoPersonRule` (boolean, on by default). Eligibility:

- A member's Change set always needs an administrator to decide.
- An administrator's own Change set: when the rule is on, another administrator is required; when the rule is off, or the scope has only one administrator, that person may decide it. Record `decisionMode: self`, with the scope flag `singleAdminMode`. A self-decision is not a silent pass: the list shows it side by side with his decision, and the top of the page has a notice.
- A role change is itself a Change set: adding an administrator needs an existing administrator to approve it, and when the two-person rule is on it needs another one.

The open-source default: the two-person rule is on; when the first administrator creates a scope, it automatically enters single-administrator mode and shows a notice. One formula: **who needs approval = a member, or an administrator and the two-person rule is on for that scope.**

## What this answers

- "If Circle connects to hub as an administrator, can it approve its own request?": yes, in single-administrator mode or when the rule is off; but the record marks the self-decision, the Decision still binds the digest, and the audit is unchanged.
- "Does a submission need approval only when a user submits it?": yes, a member's submission always needs an administrator.
- "Permissions are too scattered": a person has only a role, a machine has only a scope string, and everything else is data.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
