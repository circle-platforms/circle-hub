# Product-line pack exemplar

When a product line is brought into circle-hub, there is only one deliverable: a **product-line pack** — a collection of the four kinds of harness primitives (Skill, an MCP server instance declaration and its Tools, Hook handlers) plus original roles, flow versions, and one manifest. The hub core changes no code for any product line; a product-line pack is written to the layout and the adaptation sheet in this document, and after it is loaded into hub it takes effect when an Independent reviewer approves it.

The synthetic product line [meridian](../../../packs/meridian/) in this repository is the public sample; real product-line packs live in their own packs repositories (for example [circle-packs](https://github.com/qingshanfeihu/circle-packs)), and they do not go into hub.

## Correspondence with the object standard

A product-line pack can be inserted only through an **Extension point**, what is inserted is all **Assets**, taking effect always goes through **Change set** approval, and a run leaves **Evidence**.

| What is in the pack | Which Extension point it is inserted into | Asset kind | Who interprets it |
|---|---|---|---|
| MCP server instance declaration (read-only connector) | B · connector package (by system type) | connector-instance | hub's connector package walks only the declaration, and does not recognize a product |
| originals (command tree, function contract, manual…) | B · original upload (file + role + metadata) | knowledge-source | the method module; hub stores only the bytes and the SHA |
| object vocabulary, knowledge mapping | B · vocabulary / manifest | written in the product-line manifest | hub's knowledge layer registers claims according to the mapping |
| Skill (skill package) | E · skill package | skill-package | executed by Circle with no interface; hub checks the declared tools against the trial run |
| Tool implementation (parser, contract, result interpretation) | B / D · a provider's `provides` | product-line module | runs inside hub when the provider calls it; the input is B's bytes |
| Hook handler | E · Enforcement chain hook points (verify.* / beforeDispatch / afterResult) | product-line module | hub calls them in order at step 3 of the Enforcement chain |
| flow version | C · flow version | product-line module | hub's task engine advances it by version |
| MCP server instance declaration (execution resource) | D · resource adapter (MCP protocol) + credential mode + profile | connector-instance (execution resource) | hub's worker acts as the MCP client; the endpoint and the secret are in an out-of-database profile and the vault |

What is not in the table does not belong to a product-line pack: changing the hub core, changing the Circle core, or hard-coding an address or a credential is not "adaptation".

## Directory layout

```
<packs repository>/
  modules.json                   install manifest: each module's root, manifestPath, version, files + sha, digest
  products/<line>/
    product-line.json            manifest product-line/1: connector packages, tool aliases, connector options, knowledge mappings, tools, hooks, flows
    connectors/<package>.json    connector instance declaration template: declaration + configuration, with no address and no credential
    sources/<role>.md            for each kind of original: role, metadata keys, who uploads, how to check
    tools/<name>.ts              Tool implementation: parser, contract, result interpretation; a pure function, input is B's bytes
    hooks/<name>.ts              Hook handler: a deterministic judgment of one run, returning pass or an Error code and the facts; the manifest declares the hook point and the order
    flows/<name>.json            flow version: phases, the waitingReason enumeration, deliverables
    resources/<name>.json        execution resource declaration: writes, credential mode, runtimeProfileRef, whether executionIsChange
    README.md                    the filled-in adaptation sheet + the acceptance record
  skills/<skill-id>/
    SKILL.md                     the flow for the model: which steps are scripts, which are judgments
    skillpack.json               manifest: id, version, tools, inputs, outputs, triggers, model
    scripts/                     steps with a single answer all live here; they call no external system, and only handle the bytes B gives
    references/                  explanations of contracts and rules (originals not included)
    tests/                       tests on synthetic samples
```

Originals, device configuration, and real returns do not enter the repository: they are originals uploaded to hub at run time, they carry a SHA, and a module reads them only after an Independent reviewer has approved them.

## Adaptation sheet

To bring one capability in, fill in this table first; the answer can only be "N Assets + M flows + K rules". If any cell's answer is "change hub", go back to the design.

| Object | Questions to answer | Form of the answer |
|---|---|---|
| B | Which systems are read? One connector per system type | `connectors/*.json` + manifest connectorPackages / toolAliases |
| B | Are there originals to upload? | `sources/*.md` defines role; uploaded at run time |
| B | What Evidence is produced? What claims can be submitted? Is the source a script or a model? | the skill package's outputs; a claim's origin |
| C | Which flows are there? Each one has a version | `flows/*.json` |
| C | Which actions require an Independent reviewer? | only a Change set; a run is not approved |
| C | Which identities are there? | roles in the scope policy; a resource uses a machine identity |
| D | Which resources are touched? An adapter for which protocol? | `resources/*.json` |
| D | How are credentials supplied? | static-secret / issued by the platform / external OAuth |
| D | What counts as unknown? How is it checked? | the unknown branch and reconcile in the flow |
| E | In the Skill, which parts are scripts and which are model judgments? | SKILL.md states them in sections; scripts are in scripts/ |
| E | What does the product-line manifest declare? | `product-line.json` |
| E | Which Hooks are attached on the Enforcement chain? | `hooks/*.ts`, returning a fixed Error code |
| A | What does the user see and do in Circle? | the tools, commands, cards, and Registry used; no new interface is added |

## How each kind of Asset is written

- **Connector instance declaration**: write only the shape of declaration and configuration; the address, the account, and the CA are filled into an out-of-database profile or the vault when an administrator registers it.
- **Original**: one note per role — what the file is, which metadata keys are required, how the SHA is checked, and who may upload and read. metadata is the uploader's declaration, and hub does not verify it; what has to be verified is reported by the resource at run time.
- **Skill**: SKILL.md writes the inputs, the tools, and the outputs first, then writes the steps; each step is marked "script" or "judgment". A script handles only the bytes B gives and its own output; tool returns are saved as-is by hub, and a script holds only an evidenceId pointer. The trial-run record must cover every path the skill declares.
- **Tool implementation**: a pure function, bytes in and a structure out; it does not read the environment, does not connect to the network, and does not write files.
- **Hook handler**: the input is one run's Binding and the object to be checked; the output is pass, or one fixed Error code plus the facts. What cannot be judged is not written as a Hook, and is handed to disclosure.
- **Flow version**: the phase enumeration is fixed, waitingReason is an enumeration field, and the deliverables are listed out.
- **Resource declaration**: writes states the truth; a production resource that needs the two-person rule declares executionIsChange.

## From development to taking effect

1. Develop the skill package and the modules locally, and run tests/ on synthetic samples.
2. Log in to hub in Circle, start a trial-run record, walk the real tools once following SKILL.md (read-only), and the output carries a SHA.
3. Push: the manifest, the files, and the trial-run record are submitted together as a Change set; hub checks that the declared tools = what the trial run actually called, and that the referenced Assets are ready.
4. The Independent reviewer decides in their own Circle; after approval the version is immutable, and a change is a new version.
5. The product-line manifest, the Tool implementations, the Hook handlers, and the flows are listed by `modules.json`, installed from the repository, and are a Change set as well.
6. A run goes through the Enforcement chain, and is not approved; an error returns to the session with an Error code, and unknown is disclosed as observed.

## Acceptance checklist

- Zero changes to the hub core; the product name appears only in the manifest, the modules, the rules, and the data.
- Every Asset can be approved by an Independent reviewer, pinned by a SHA, and disabled.
- The Skill's trial run covers every declared path; not a single undeclared Tool is called.
- A run failure has only a fixed Error code; there is no record of "approved by the platform".
- A second product line is installed without changing the core.
- The repository contains no originals, no addresses, no credentials, and no real returns.

## Sample: meridian

[packs/meridian](../../../packs/meridian/) is a fictional product line: one product-line/1 manifest and one source-review skill, `meridian-source-review`. It reads a document connector, submits candidate claims, and produces a review report. It touches no resource, and only registration needs approval. The reason it exists is to prove this: a second product line goes through on the same core, the same permission, the same approval, and the same execution, without changing one line of core code.
