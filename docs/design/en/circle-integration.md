# Integration with Circle

## hub is an enhancement of Circle, not another home page

Circle is the agent you run yourself; hub is the process the team runs. The same product, two ways to run it: `circle` and `circle hub`. An administrator uses Circle too, only with a different role, and there is no second administration program; a host without graphics uses the command line that comes with hub.

Why a resident process is still required: independent approval needs shared state; tasks and Evidence must outlive the session and the machine; what constrains the agent cannot run inside the agent process.

## Menu: extend, not side by side

B/C/D/E in the internal standard do not enter the user menu. In the user's eyes a skill is a skill and a tool is a tool, with no split between local and hub. Once connected to hub, Circle's menu items are extended:

| Circle menu | Once connected to hub | Corresponding standard |
|---|---|---|
| sessions | work: local sessions + hub tasks mixed together, with status; the "needs me" count (awaiting my approval / awaiting my response / exceptions) | C work |
| skills | local skills + hub skill packages, the same table, with a "source" column; tabs inside the page: skill package / product-line module / rule | E |
| tools · mcp servers | local tools + the hub tool catalog (`srv_*`), the same table | B's connectors, D's resource tools |
| approvals | local permissions + hub Approval requests, two tabs inside the page, not counted together | C approval |
| new · materials | sources, originals, claims, snapshots; appears only after logging in to hub | B |
| new · resources | gateways, workers, operations, the scene, Unknown outcomes; appears only after logging in | D |
| settings › hub | login, scope, people, policy, worker, notifications | C identity and policy |

The letters B/C/D/E remain only in the standard documents and in the small "object standard" label on a Registry page.

## The sync model

Circle stores no B/C/D/E locally; what it shows is always the projection hub computes for the current identity.

- **Pull**: every list is a hub query (with an ETag); task events are caught up by cursor, and a reconnect after a disconnect continues from the cursor, with nothing lost.
- **Push**: hub sends a notification stream for "needs me" items (Approval requests, awaiting a response, exceptions); Circle subscribes, and if it breaks, falls back to polling.
- **A card is a projection**: the approval card and the error card in a session correspond to Records on hub; before "approve" is clicked it is read once more, a card someone else has already handled becomes "already handled by someone", and it is not approved twice.
- **Status line**: "hub · synced 12 seconds ago / offline"; while offline the task keeps running on hub, and a reconnect refreshes it.
- **Circle installed alone, without logging in to hub**: these entries are absent, and Circle is a general-purpose harness. Once logged in, a person sees only what is inside their own scope, and counts are computed on the server by identity.
- One Circle connects to one hub at a time (the first version).

## What a session (L0) looks like

Left column: the "needs me" count, the "work" list (local sessions and hub tasks mixed), and Circle's existing menu (including the extended items). Middle: the session; hub's accepted, Evidence, passed the gate, and Verification come back as event lines; things that need a person are inline cards — an error card (Error code + the facts + the applicant's choice) and an approval card (Change set + Binding + Eligibility + approve / decline). The side column on the right: this task's phase, Binding, Evidence, and output. Bottom: the input box and the status line.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
