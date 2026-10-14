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

## 4. B's rules for originals and Evidence

- An uploaded original is pinned by the SHA of its bytes; an upload with the same SHA in the same scope reuses the same source revision. When the bytes of an original, an artifact, or an Evidence record are downloaded, the platform re-checks the stored bytes' SHA and gives the digest in a response header (x-content-sha256); a client recomputes the SHA-256 after downloading and compares it with the reference. Every download re-checks the current identity and the source permission.
- An Evidence record keeps pointers, scopes, SHAs, and small excerpts, and never stuffs a large file or the full text of invalid UTF-8 into a structured record. A worker's report first places the originals in B by SHA, then carries {path, sha256, objectKey, size} in the report; the platform reads them back under the current lease, input, and asset authorization and verifies the actual bytes and sizes — a missing file, a changed SHA, or a wrong size is not accepted. Any error in processing a report atomically lands as failed; a storage exception yields only `RECEIPT_PROCESSING_FAILED` with a safe classification, and carries no SQL, parameters, content, or internal paths.
- An original's SHA is re-checked along the whole line: at admission, at the worker's read, at the server's read, in the dispatch receipt, and in the result. An as-is return from an interaction with the outside passes through redaction before it reaches the caller; the original text stays readable in B under the current permissions.
- A successful read-only receipt settles into knowledge through an eventually consistent asynchronous indexing: the synchronous reply only verifies the SHA, stores the original/Evidence, and persists the outbox, and the read returns at once; an independent runner extracts structural observations from the originals and writes claims and assessments in batches, and the product snapshot updates only after the whole indexing task has succeeded. A claim is marked origin=script and an assessment semantic=not-asserted: they prove only the literal content and structure, and the existence of a command never asserts that a whole feature is supported. A failed indexing does not re-judge the original read as failed. Retrieval filters by the actual reader, the current asset and source permissions, the read grants, and the personal credential state, and a snapshot's publication widens no permission; batch records stage their members first and then incrementally replace the source's claim closure, instead of walking the whole scope claim by claim.
- An external source artifact follows the line "upload the originals → register a knowledge-source Asset → independent approval": the approval yields a source-artifact id with the sar_ prefix, bound to the asset version, the declared metadata, and the digests of all files; a repeated registration with the same asset id, version, originals, and declaration reuses the same asset, and changed content requires a new version. The visibility of a pending draft follows [Approvals and the enforcement chain](approvals-and-enforcement.md#only-one-approval-concept-the-change-set). A read bound to a source artifact uses only the artifact's originals and never falls back to the network, and the result is marked origin=uploaded-artifact, live=false — what it proves is the artifact's bytes, not the remote side's current state. The uploader-declared metadata (for example an expected build name) is declared data: the platform does not interpret it and never takes it as fact; a self-reported digest or certification inside a file replaces neither the SHA of the uploaded original bytes nor the independent approval.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
