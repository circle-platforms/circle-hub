# Levels and elements

Design hub's entry first, then go deeper level by level; each level fixes which diagram, table, description, and buttons it uses, and existing work only fills content into it. Taken from the shared practice of the Claude Code desktop and the Codex desktop, without copying their surface: the session is the entry, the left column is the work list, things that need a person appear as inline cards and aggregate in the left column, Evidence sits in the side column, and the actions are few and fixed.

## Five levels, deeper one by one

| Level | What it is | Enter |
|---|---|---|
| L0 session | A Circle session is the entry. hub's work is handed over here, and progress, Evidence, and things that need a person come back here as cards | any session after logging in to hub |
| L1 Work queue | awaiting my approval / awaiting my response / submitted by me / owned by me / exceptions. Sorted by age, reviewed one by one | the "needs me" count in the left column |
| L2 Registry | one object's Records: facets + counts + search. The four objects share one template | a left-column menu item, or the object of a queue row |
| L3 record detail | five cells: Asset · content · approval · Evidence · Extension point. The Decision is made here, and can also be made in an L0 card | a Registry row, or a card's "open" |
| L4 Evidence original | the return the platform saved as-is: sha, who, when, which tool; it can be cited, and it cannot be changed | any evidenceId |

Any level can return to the session.

## What each level uses

| Level | Diagram | Table | Description | Buttons |
|---|---|---|---|---|
| L0 session | none; only inline cards | none | one sentence for an event (accepted / Evidence / passed the gate / Verification); error card: Error code + facts + the applicant's choice; approval card: Change set + Binding + Eligibility | approve · decline · respond · open · follow |
| L1 queue | a count bar; the distribution of age and of items past SLA | queue table: object · request · flow@version · scope / product line · applicant · age · expiry · status · Eligibility | one statistics line; the Eligibility reason | previous · next · approve · decline · save view |
| L2 Registry | none; facets instead | Registry table: name · kind · version · lifecycle · owner · updated | one sentence for the object; four Platform invariants | register · upload · push · hand over · open |
| L3 detail | Binding diagram: request ↔ input revision / target identity / action digest; its place in the data flow | file table · Evidence table · Decision table | Asset bar; Verification vs Submission; Eligibility | approve · decline · new version · disable · check |
| L4 Evidence | none | the as-is return (read-only) | sha · who · when · tool · input digest | copy id · cite · download |

An element that is not in the table does not appear on that level.

## Only four diagrams

- **Data-flow diagram**: how one piece of work passes through A C E B D, with ids.
- **Binding diagram**: the three items one Approval request pins, and the Record each of them points to.
- **Execution topology**: hub → worker → resource, who holds the credential and who touches an external system.
- **Lifecycle diagram**: an Asset's draft → approved → running → retired, and the correspondence with approval status.

Everything else is expressed with tables and counts; do not draw a schematic architecture diagram.

## Action words are fixed; every level uses these

| Action | Applies to |
|---|---|
| approve / decline | one Approval request; binds its digest; a superseded one can also be declined |
| respond | a task waiting for my input |
| open | go to the next level |
| follow | bring the task events back to the session |
| check | the reconcile of an Unknown outcome |
| register | a source, a resource, a service client |
| upload | an original, with role |
| push | a skill package, with a trial-run record |
| hand over | give the work to hub |
| new version | an Asset replaces its bytes |
| disable | an Asset is retired |

There are no words like "confirm", "submit", or "save" that do not point at an object.
