# Roles and scope

> **Superseded** (2026-10-21): scoped administrator, member and guest roles, the two-person rule and service clients were retired with the old server. There are now two permission roles, user and administrator; runs and results are visible by default only to the runner and administrators, and anything absent or forbidden reads “对你不可用” (not available to you). See R01 and R02 in the [generic model](generic-model.md). Kept as a record only.

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

## Sessions and tokens

- The development identity source is enabled only by explicit configuration, and it is not enterprise authentication; accounts and grants come only from the server's configuration and policy, and an identity, role, or tenant asserted in a request body grants nothing.
- A session token is valid for eight hours by default (configurable, from one second to twenty-four hours); a shorter validity explicitly requested is honored. Renewal accepts only a session that is still valid, unrevoked, and not disabled: it asks no password, accepts no self-reported lifetime, identity, or scope, and re-reads the scopes from the current policy. Renewal rotates the token, with a five-second grace for the old one; a session family has an absolute lifetime of twenty-four hours that renewal cannot extend. An expired credential is a 401, and no session is recovered from it; an explicit logout revokes the whole family at once. Password failures lock out, and the request buckets and hashing concurrency are capped — exceeding them is `RATE_LIMITED`, and the error echoes neither credentials nor user names.
- A short-lived run token is not a session: it can be neither renewed nor logged out, and only the worker holding a valid lease extends it, up to that operation's deadline.
- The roles in a development identity file are only the initial seeding; afterwards roles are managed through scope Change sets, and a restart never overwrites governed roles with the identity file. An identity removed from the configuration lapses at restart.

## Role registration and the disclosure of eligibility

- A person's login response carries roles (one role per scope) and does not expose the internal action strings; a machine identity has only authorized scope strings. The scope endpoint discloses each scope's twoPersonRule, policyVersion, adminCount, and singleAdminMode; every record of the role registry carries its revision, the platform Verification, and the Change set reference.
- A change to roles or scope policy is a Change set: it is registered as a frozen draft and takes effect only after an independent decision, and the response must carry the Binding back verbatim. Only a person in the same tenant can be granted a role; the last root administrator cannot be removed.
- The disclosure of Eligibility and Decisions is fixed: decisionMode is self or independent, singleAdminMode is given as-is, and the audit records the same fields plus the policyVersion. A self-decision has a Decision record and is not a silent pass. A Verification means only a programmatic check by a rule id/version, and is never a person's approval.
- Action and target authorization is still checked live on every access; a person's role does not replace source readers and resource policies, and a machine scope string never impersonates a person's role.
- A Tool of any provider carrying a credential reference requires at least the member role, and both the catalog and calls refuse a guest; a guest may only call read-only providers without credentials. Sharing a static resource does not widen anyone's role.
- A task of a tool call or a personal run belongs to its caller from the start: others in the scope cannot read its content or candidates, and lists are filtered before they are paged; a source ACL and a task's scope permission never substitute for each other. For a personal result to become team knowledge, it goes through knowledge review and publication — a personal task is never published directly.

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
