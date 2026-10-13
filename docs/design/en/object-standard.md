# Object standard and data flow

## 1. Every object is these five parts

hub's four objects — materials B, work C, execution D, and method E — are made of the same five parts. Rows are the standard, columns are the objects, and each cell writes only instances of that object.

| Standard | B materials | C work | D execution | E method |
|---|---|---|---|---|
| **1 Record**: record types the object itself owns, each with an id prefix and a version; byte records carry sha256 | source revision `src_` · Evidence `evd_` · claim `clm_`, assessment · snapshot `ks_` (immutable) · artifact `art_` (with sha) | identity `prn_` · scope `scp_` · task `task_` · input revision `inrev_` · Approval request `pin_` · Decision · bot · trigger · audit | resource (gateway, worker, SSH target) · operation `op_` · Binding pin · lease and fencing token · scene · Unknown outcome | skill package `skp_` + trial-run record · product-line manifest `product-line/1` · method module · rule · validation sample |
| **2 Asset**: something pluggable, one shape: kind · version · sha256 · declaration · configuration · lifecycle | knowledge-source (uploaded original) · connector-instance (read-only MCP server: documents, build site, ticket mirror, environment) · runtime-profile | bot · trigger · service client (a resource's identity in C) | connector-instance (execution resource, that is, the MCP server that acts) · worker · runtime-profile | skill-package (Skill) · product-line module (Tool implementation and Hook handler) |
| **3 Approval policy**: the unit is a Change set; which actions require an Independent reviewer; Binding is inputRevision + targetIdentity + actionDigest | source / original lifecycle → approved · claim candidate → into the snapshot | all approvals land here · enabling a bot, authorizing a person | enabling a resource to running · execution is not approved: a provably true failure is reported as an error, and what is not provably true is disclosed; a resource may declare "execution against me counts as a change" | skill version registration · module installation |
| **4 Evidence**: the as-is record of each interaction with the outside; evidenceId is issued by the platform; script / model are marked separately | originals the connector read · the return of each Tool call | trial-run record (which Tools the Skill actually called) · Decision and audit | Hook judgment · scene report, lease events | trial-run output sha · Hook judgment (rule id, version, on whom) |
| **5 Extension point**: where something is allowed to be inserted; product content does not enter the core | read-only MCP server (connector package, by system type) · original upload (file + role + metadata) · object vocabulary · knowledge mapping | identity provider · policy (data) · flow version · result channel | MCP server that acts (resource adapter; the MCP protocol is the generic adapter) · credential mode · profile file · worker protocol | Skill (modules.json in the packs repository) · product-line manifest · Tool implementation · Hook handler |

In Circle, every Registry page is a projection of these five parts: the left column is Records (facets + counts + search), and the right column's five cells are fixed as Asset · content (Verification / Submission) · approval · Evidence · Extension point.

## 2. Data flow: every piece of work follows this line

Each step passes only an id, and the agent does not type the content again.

1. **A submit**: hand over the work in a Circle session (files, trigger).
2. **C accept**: a durable task + an input revision `task_ · inrev_ r1`; a resend does not become a second copy.
3. **E choose a method**: the skill package decides which tools to call and which rules to pass through `skp_ · digest`.
4. **B read materials**: connector / original; each return is stored as-is `src_ · sar_ · evd_`.
5. **E Enforcement chain Verification**: permission · Binding · rule; a provably true failure is reported as an error straight back to Circle `rule · pin · Error code`.
6. **D claim execution**: pin the resource version + credential + method; the worker against the resource `op_ · pin · lease`.
7. **B report into Evidence**: the scene enters B as-is; unknown stays unknown `evd_ · unknown`.
8. **C result and disclosure**: pass → deliver; an error carries the facts; unknown is disclosed as observed, and the applicant chooses the next step `succeeded · failed · unknown`.
9. **A retrieve**: the artifact returns to the session with its sha; closing Circle does not stop it `delivered · art_`.
10. **B settle**: candidate claim → independent review → snapshot `clm_ · ks_`.

Change set approval happens before this line: methods, resources, and sources are approved once when registered; a run follows only the Enforcement chain, and the platform is not an approver.

## 3. Adaptation sheet: when a new capability or an old system is brought in, fill in this table

The answer can only be "N Assets + M flows + K rules", and it cannot be a change to hub's code.

| Object | Questions to answer |
|---|---|
| B | Which systems are read? One connector per system type. Are there originals to upload (file + role + metadata)? What Evidence is produced? What claims can be submitted, and is the source the script or the model? |
| C | Which flows are there, and what is each one's version? Which actions require an Independent reviewer? Which identities are there — a person, a service client? |
| D | Which resources are touched? An adapter for which protocol? How are credentials supplied (static key / issued by hub / external OAuth)? What counts as unknown, and how is it checked? |
| E | In the skill package, what do the prompts do, and what does the script do? What does the product-line manifest declare? Which deterministic rules does hub run at the boundary, and which are model judgments? |
| A | What does the user see and do in Circle? Use only the existing tool projection, commands, cards, and Registry, and add no new interface. |

The check once it is filled in: zero changes to the hub core; the product name appears only in the manifest, the modules, and the data; every Asset can be approved by an Independent reviewer, pinned by sha, and disabled. For a filled-in sample see the [product-line pack exemplar](product-line-pack.md); the only things inserted at an Extension point are four kinds of harness primitives, see the [harness primitive specification](harness-primitives.md).
