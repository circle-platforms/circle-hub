# Terms and states

Terms enter the contract in F, with one-to-one Chinese–English correspondence; states are always enumerations, with fixed words and colors; lists are always queries. When the identity differs, a page changes only the counts, and does not change the structure.

## Terminology

| Term | Identifier | Meaning | No longer used |
|---|---|---|---|
| Record | Record | An entry the object itself owns, with an id prefix and a version | — |
| Asset | Asset | Something pluggable; kind · version · sha256 · declaration · configuration · lifecycle | package, plugin, configuration |
| Approval policy | Approval policy | Object level: which actions require an Independent reviewer | change gate |
| Approval request | Approval request · `pin_` | Instance level: one request awaiting a decision, pinning the Binding | pending approval, ticket, to-do |
| Decision | Decision | The result and record of an Approval request: approved / declined | approved it, rejected it |
| Binding | Binding · inputRevisionId / targetIdentity / actionDigest | The three values the request pins; any one changing invalidates it | pin the three things |
| Independent reviewer | Independent reviewer | A person other than the applicant who holds approve permission in that scope | another person, someone else |
| Eligibility | Eligibility | Whether the current identity can decide that request, and the reason | whether you can approve |
| Verification | Verification | Facts the platform computes itself: tool match, SHA, re-check before dispatch | checked by hub |
| Submission | Submission | The action and parameters the applicant submits, shown as-is, not verified | declared by the submitter |
| Evidence | Evidence · `evd_` | The as-is record of each interaction with the outside | receipt, return |
| Extension point | Extension point | An interface type the object allows to be inserted | connection |
| Work queue | Work queue | The pending set computed for the current identity | to-do, waiting on you |
| Waiting reason | waitingReason | The reason a task has stopped, a separate field, not a status | writing the reason as a status |
| Platform invariant | Platform invariant | A rule the platform enforces unconditionally | forced by hub |
| Registry | Registry | The object page: facets + counts + search, not a sample list | list |
| Change set | Change set | One or more asset versions submitted together; one Decision, taking effect atomically; referenced assets are not approved again | approving assets one by one |
| Enforcement chain | Enforcement chain | The five steps the platform performs at run time: permission · Binding · Verification · lease · audit. The only results are pass / error / unknown; there is no approval, and the platform is not an approver | runtime approval, pre-authorization, exception approval |
| Run error | Run error · provably true | A failure in the Enforcement chain that the script can determine, returned to Circle with an Error code and the facts | letting the approver decide |
| Unknown outcome | Unknown outcome · as observed | A result the script cannot determine: disclose everything observed, and do not resend; the applicant chooses to check, mark it failed, or give up | treating it as failure or success |
| Error code | Error code | The fixed identifier of a provably true failure: COMMAND_NOT_IN_TREE · DESTRUCTIVE_COMMAND · BUILD_MISMATCH · GATEWAY_UNREACHABLE · PERMISSION_DENIED · LEASE_UNAVAILABLE · SOURCE_NOT_APPROVED | a free-text failure reason |

## State enumerations

Gray = not in effect or terminal · orange = waiting on a person · blue = in progress · green = pass · red = declined or abnormal.

| Field | Value |
|---|---|
| `task.phase` | received · running · waiting-input · waiting-review · delivered · failed · cancelled |
| `approval.status` | open · approved · declined · expired · superseded |
| `asset.lifecycle` | draft · approved · running · retired · declined |
| `operation.status` | queued · claimed · running · succeeded · failed · unknown · reconciled |
| `claim.origin` | script · model (the candidate uses approval.status; do not coin a new word) |

A row is always "status + waiting reason": `waiting-input` plus `waitingReason: gateway-configuration`; do not write "waiting for gateway configuration" as a status.

## Handling and display at scale

This still holds when tasks number in the thousands, approvals in the hundreds, and Evidence in the tens of thousands:

1. **A list is a query**: every list is a server-side query + facets (scope · product line · flow · status · owner · age) + counts + cursor pagination + a saveable view. There is no "all".
2. **The queue is the home page**: awaiting my approval / awaiting my response / submitted by me / owned by me / exceptions. Sorted by age by default, showing the oldest and those past SLA.
3. **The object page is a Registry**: the left column is facets and counts, not samples; the five detail cells stay unchanged.
4. **Aggregation levels**: tenant → scope → product line → flow → task. The overview shows only counts and exceptions.
5. **Exceptions first**: unknown, expired, superseded, failed, and worker offline each form their own queue, with aging time.
6. **Review one by one, with no batch approval**: each Decision is bound to its own digest; the queue provides previous / next.
7. **Status is an enumeration, and the reason is a field**: filtering uses only the enumeration.
8. **Identity changes only the counts**: administrators and members see the same page, and the structure does not change.
9. **Approval is at change time, not at run time**: a Change set is approved once; a run goes through the Enforcement chain; what is provably true is reported as an error directly, and what is not provably true is disclosed as observed. The record writes only "verified according to the rules", and does not write "hub approved".

Fields for hub to add: `task.priority · task.assignee · task.dueAt · task.waitingReason · approval.supersededBy · operation.unknownSince · asset.productLineId`, saved views, Change set, Approval policy as data, Enforcement chain Error codes and the disclosure format, notification stream.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
