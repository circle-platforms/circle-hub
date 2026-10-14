# Execution flows in product-line packs

This is the English companion to the [execution-flow migration design](../execution-flow-packs.md). The bounded A2 contract and driver-injection section below correspond to the Chinese text. The original migration plan keeps product interpretation in independent product modules and permissions, transport, leases, unknown decisions, evidence storage and governance in Hub. A3 is a generic-driver implementation proven with synthetic modules; it does not establish that native APV execution has moved to the new product module or that any real environment has been deployed.

The design uses the existing [product-line pack contract](product-line-pack.md), [harness primitives](harness-primitives.md) and [approval and enforcement chain](approvals-and-enforcement.md). It adds no REST resource, permission concept, Hook point or event interface.

## Ownership and loading

`Modules.install` verifies the complete `modules.json` file set, individual SHA values, module identity and digest, then registers frozen originals as a knowledge-source asset with a Change set. Installation does not approve a module. `ProductModules.load` loads an approved `product-line/1` revision with declared tools, hooks, flows and resources. Pure Tool calls run in the restricted tool-host process. Relative imports stay inside the frozen file set; external imports require the supported exact version in that file's `tools[].imports`. Node built-ins, Hub source, computed imports and undeclared dependencies are refused with `IMPORT_NOT_DECLARED`.

The product module owns workbook and function-contract interpretation, environment and log parsing, product states, parameter construction and interpretation candidates. Hub owns database transactions, task and input revisions, immutable binding, effect and role checks, profile and credential handling, provider RPC, both lease layers, fencing, cancellation, uncertain dispatch and B originals. Moving the existing controller or worker into a different directory does not make its SQL, vault, filesystem or network access a permitted pure Tool.

Native `apv-case-execute` remains version `1.1.1` with flow `apv-case-execute/1`. Its existing implementation digest is distinct from an independent module digest. Migrated modules use a new implementation version and explicitly approved module/flow identity. Historical tasks retain their original methodAssetId, implementation and evidence; no database rewrite silently migrates pending or unknown work. The compatible native path is retired only through a separate maintainer decision after outstanding work has been accounted for.

A1 supplies exact approved historical pins to `ProductModules.load` and `SourceArtifacts.snapshot`; a draft does not change a frozen run. Reading a pin still checks live authorization and the selected and latest-approved reader boundaries. Product Tool failures affect interpretation, not an independently proven D terminal: parser errors, timeouts, oversize output, invalid protocol, missing mappings and result-Hook failures cannot create a second submission or turn known execution into uncertain dispatch. The [Chinese migration plan](../execution-flow-packs.md#实现顺序与验收) records the broader migration sequence; the contract below is the executable data boundary.

## Appendix A2: bounded internal transition contract

`packages/contracts/src/execution-transition.ts` supplies a schema factory. F's index instantiates and exports it after the shared ID, SHA, hash and error definitions exist. The file depends only on zod, with no reverse import of B, D or E. `ExecutionTransitionAssetPin` has the same fields as A1's `AssetRevisionPin`: `{assetId, version, sha256, digest?}`. A method pin additionally includes the capability id, flow version and execution implementation digest. A2 defines and validates data; it does not itself register a driver, HTTP route, Hook or capability, or change native `1.1.1` bytes or its digest.

Input is `{schema, binding, currentInput, state, observations, controlledBytes}`; output is `{schema, state, actions}`. The schema is `hub-execution-transition/1`. The binding holds taskId, inputRevisionId, inputSha256, the method pin and named resource/source pins. `currentInput` is `{value, sha256}`: C retrieves the immutable input revision and checks ownership and authorization before injection. `canonicalHash(value)` must equal both currentInput.sha256 and binding.inputSha256. Equal self-reported bytes and hashes prove consistency, not authority over that revision; the driver must check C's record. Workbooks are B original references, not full text copied into ordinary JSON. State, current input value, facts, args, subjects and result candidates must be finite JSON. NaN/Infinity, undefined, BigInt, functions, class/Date/Map instances, cycles, sparse arrays, symbols, accessors, prototype keys and properties lost by JSON serialization are refused. Product state cannot change Hub task phase.

Every action has a strict top-level shape and `stepId / occurrence`. One output cannot repeat that step identity:

| kind | Specific fields | Driver checks |
|---|---|---|
| `tool.call` | `path, export, args, byteSlots?` | Declared frozen Tool path, relative imports and export; authorized original slots |
| `provider.call` | `resource, tool, args, byteArgs?` | Bound resource, approved provides, current permission, effect, minimumRole, input schema and request digest; authorized bytes cannot overwrite args |
| `operation.wait` | `operationId` | An existing operation in this task/current revision; observe it without submitting another write |
| `hook.verify` | `event, subject` | One of the existing five points; exact subject checked by `validateHookInput`, approved binding injected by Hub |
| `outcome.error` | `code, facts` | Registered code and original-backed facts; no product authority over D unknown or resource freezing |
| `delivery.propose` | `status, result, references` | succeeded/partial only; actual evidence and delivery checks before delivery |

These actions expose no endpoint, credential, secret, CA, effect override, fence, approval decision or freeze instruction. Legitimate product/log strings may appear in args; A2 does not infer their meaning from a dangerous-word filter. Schema validity alone is not dispatch permission. A3 also checks the actual approved provider schema and Enforcement chain. Bounded Hook subject JSON does not permit arbitrary subjects at a Hook point.

`provider.call.byteArgs` is an optional `{parameterName: slot}` map. `{payload_b64:"payload"}` names an original slot rather than asking a model or transition to copy base64. Parameter keys are nonempty, follow the ordinary JSON-key budget and exclude control characters and prototype injection keys such as `__proto__ / constructor / prototype`. The provider inputSchema defines the actual accepted names. A name also present in args is refused; the driver does not overwrite a literal parameter. Base64 longer than 32 KiB in ordinary args is refused like any other ordinary long string. Before dispatch, Hub reads B under the current permission, approved source pin and SHA, fills the parameter, then checks the provider input and entire wire. Access to bytes alone is not execution permission.

Observations are `{operationId, reference, facts}`. A reference is one of four strict forms: sourceRevisionId/artifactId/evidenceId/recordId, with kind, sha256 and size, without a client download URL. Each controlled slot is `{slot, role, encoding:"base64", reference, contentBase64}`. Slots are unique, base64 is canonical, decoded length equals reference.size, and the original-byte SHA equals reference.sha256. Roles identify the originals a module needs. A3 also verifies that references belong to the approved source manifest, are currently authorized and were actually read from B. A client-created JSON value with a correct hash does not acquire original access.

Controlled log bytes may contain addresses required for parsing. A pure Tool has no network capability and cannot turn them into connection targets. If facts are sanitized, environment and log identifiers must still match consistently. Words such as terminal/pass in observation facts remain interpretation data. Hub must independently verify and persist D terminal facts against the approved provider original, operation, workbook and remote identity; clients and product Tools cannot self-certify them. Parser failure does not change a proven terminal.

This is an authorized-input inventory, not an APV-specific schema. The module declares roles; Hub supplies their B references and necessary bytes. Valid fields do not replace verification:

| Consumer | Authorized B originals | Necessary facts and excluded authority |
|---|---|---|
| Environment Tool | Frozen env_prepare and bed_topology returns | Task/input revision, frozen method/source/resource pins, bound workbook SHA, remote task identity if known; original fields or consistently sanitized identifiers for build/device mapping. No credentials, endpoints, CA paths or callable handles |
| Results Tool | Original case_submit/status/results, per-case logs/sessions, workbook; command-check original when its role is required | Task/revision, remote id, workbook SHA, pins, independently proven terminal and remote lease-release facts. Missing fields remain unmapped. The measured batch did not contain sessions |
| Transition Tool | The above references and verified facts; explicit controlled byte slots for format interpretation | Step identities, frozen bindings, original observations and public terminal/release facts. No keys, lease tokens, endpoints, CA or provider objects; command-check is not copied into state |

Hub derives the step key as `canonicalHash({taskId, inputRevisionId, methodPinDigest, flowVersion, stepId, occurrence})`. methodPinDigest is the canonicalHash of the frozen method pin and flowVersion must match that method. Products cannot select the raw key or jump occurrences. The request hash separately includes the frozen binding, inputSha256 and action/args. Adding argsDigest to the step key must not turn changed parameters into another write. currentInput.value/sha256 are also not added to the key; C owns input-revision immutability. The persistent driver rejects the same key with changed content as `IDEMPOTENCY_MISMATCH`. A2 itself only provides the two contract hash functions.

`executionTransitionRequestHash(binding, action, byteBindings?)` accepts ref-only `{slot, role, reference}` entries as its third argument and also accepts full controlled entries. Full entries still check canonical base64, decoded size and SHA. Every slot used by provider.byteArgs or tool.byteSlots must exist; duplicate/missing slots, changed SHA and decoded totals beyond 8 MiB are refused. The request hash includes each used slot's role and reference identity/SHA/size, not base64 content. A changed original in the same slot changes requestHash; unused valid slots do not. The driver can hash references obtained from authorized B lookup without sending the original to transition. Self-reported references gain no authority, and the step-key formula stays unchanged.

### Driver-injected shape

This is the actual transition input injected by the current A3 driver, not a new HTTP submission body. The entry accepts [FlowSubmission](../../../packages/execution/src/flow-contracts.ts). [C constructs the full frame](../../../packages/execution/src/flow-driver.ts), and the [worker calls transition with that one argument](../../../packages/execution/src/flow-worker.ts). Pure Tools do not obtain configuration from the environment or receive the worker's provider, credentials or lease objects.

| Field | Current source and consumption |
|---|---|
| `currentInput.value` | The **entire frozen FlowSubmission**, including flowId, methodPin, resources, sources, value, controlledBytes and optional deadlineMs. Product values are at `input.currentInput.value.value`, not directly at `input.currentInput.value`. Its digest is bound to both currentInput.sha256 and binding.inputSha256 |
| `binding.resources` / `provider.call.resource` | Named resource pins from submission. The action names their alias, such as `bed`, not an assetId, URL or provider object. C resolves approved assets/configuration and repeatedly checks permission, actual protocol-tool roles and effect |
| `state` | The module's flow.initialState initially, then its persistently recorded previous output state; not Hub task phase. Products cannot create or restore D leases here |
| `observations` | C's `{operationId,reference,facts}` records, with recorded stepId/status/result fields. Locate an observation by its logical stepId and keep its actual operationId; do not substitute a Tool name, array index or invented id |
| `expectedOccurrences` | Hub's `{stepId,nextOccurrence}` from durable task/revision steps. A new step starts at zero; only contiguous completed occurrences permit a later one. Products follow [occurrence checks](../../../packages/execution/src/flow-occurrences.ts), with no gaps, reserved `hub.` identities or replay of unknown writes by incrementing a number |
| `controlledBytes` | Authorized B slot/role/reference/canonical base64. Tool byteSlots are decoded in the declared order and appended to args as byte arguments, not paths or network handles. Provider byteArgs map parameter names to slots filled by Hub at dispatch |

The complete frame below uses synthetic placeholder pins. It illustrates fields and digest consistency, not approval or a ready resource configuration. currentInput.sha256 matches the canonicalHash of its entire value; the payload SHA and 17-byte length also match. Only C can inject a real frame; copying example identities does not grant permission.

```json
{
  "schema": "hub-execution-transition/1",
  "binding": {
    "taskId": "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "inputRevisionId": "inrev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "inputSha256": "f6abf0fd6ebbde51ccbe34c18865e60a5fa65e0c8f19c0583744af963cbbe764",
    "method": {
      "assetId": "ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "version": "1.0.0",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "capabilityPackId": "synthetic-flow",
      "flowVersion": "synthetic-flow/1",
      "implementationSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    },
    "resources": {
      "bed": {
        "assetId": "ast_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "version": "1.0.0",
        "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    },
    "sources": {
      "payload": {
        "assetId": "ast_cccccccccccccccccccccccccccccccc",
        "version": "1.0.0",
        "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    }
  },
  "currentInput": {
    "value": {
      "flowId": "synthetic-flow",
      "methodPin": {
        "assetId": "ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "version": "1.0.0",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "resources": {
        "bed": {
          "assetId": "ast_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "version": "1.0.0",
          "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      },
      "sources": {
        "payload": {
          "assetId": "ast_cccccccccccccccccccccccccccccccc",
          "version": "1.0.0",
          "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      },
      "value": {
        "expectedBuild": "synthetic-build"
      },
      "controlledBytes": [
        {
          "slot": "payload",
          "role": "payload",
          "source": "payload",
          "path": "payload.txt"
        }
      ]
    },
    "sha256": "f6abf0fd6ebbde51ccbe34c18865e60a5fa65e0c8f19c0583744af963cbbe764"
  },
  "state": {
    "stage": "prepare"
  },
  "observations": [],
  "controlledBytes": [
    {
      "slot": "payload",
      "role": "payload",
      "encoding": "base64",
      "reference": {
        "kind": "source",
        "sourceRevisionId": "src_dddddddddddddddddddddddddddddddd",
        "sha256": "2d7c09188d414c888f37b661e27aecdd54231e027ea2c8ad9c1e313aab34c5d9",
        "size": 17
      },
      "contentBase64": "c3ludGhldGljIHBheWxvYWQ="
    }
  ],
  "expectedOccurrences": []
}
```

For example, a preparation stage may request an approved read observation. Its own operationId and B reference enter the next frame:

```json
{
  "schema":"hub-execution-transition/1",
  "state":{"stage":"environment-requested"},
  "actions":[{"kind":"provider.call","stepId":"environment","occurrence":0,"resource":"bed","tool":"env_prepare","args":{"device_build":"synthetic-build"}}]
}
```

env_prepare and bed_topology are not special hard-coded Hub Tools. Their names, read effect and input schema come from the approved provider declaration. A topology observation likewise has its own provider.call. The current ordinary read branch directly invokes the Tool and **does not automatically acquire a remote lease**. If an observation endpoint requires one, a bare read action cannot invent it and transition cannot supply a lease token. Observations must come from an approved Tool that really permits an independent read, or from originals retained by the Hub-managed write protocol. The example does not prove that an existing gateway accepts either name without a lease.

The confirmed direction for the later C phase is an **optional prepare stage** in receiptPolicy. An approved Tool name and parameter mapping will select the call; the worker will execute it under the same remote lease before submit, Hub will persist its preparation observation, and beforeDispatch will verify that observation. This documentation round does not implement it or add prepare to the current ProviderPolicy schema or examples. The exact fields/mapping schema and new worker ABI still require later design and acceptance; products cannot invent that authority by adding keys to today's args.

C implementation must also change and verify the ordering. The current forced beforeDispatch runs in C preflight, before worker acquire/preparation. The future exit must run again after the preparation observation has been persisted and before dispatch intent and submit; an earlier pass cannot stand in for the new observation. Preparation does not prove dispatch, and its success does not prove successful submission. Native APV execution.environment.observed comes from its pre-submit env_prepare, while the gateway may observe or reject again inside case_submit: these are different calls and times. A future generic prepare observation must likewise retain its own original and operation identity, without presenting either existing observation as an implemented new stage. The real env_prepare/bed_topology endpoints currently require a remote lease, so the bare read example above illustrates parameter shape rather than an executable path for that gateway.

For a write provider.call, the worker automatically follows the bound receiptPolicy's acquire/heartbeat/submit/status/results/release protocol while C records intent, identity, terminal and release facts. Transition does not manage that lease state or carry acquired tokens into later args. Once controlled result bytes are available, it may propose a tool.call with small format parameters in args and real frame slots in byteSlots. For example, `args:[{"format":"synthetic"}]` and `byteSlots:["payload"]` produce a positional call such as `parse({format:"synthetic"}, bytes)`. Missing slots, invalid role/source, SHA/size mismatch and oversized actual wire are refused; model-transcribed base64 cannot bypass that boundary.

The two exit points currently behave differently:

- **beforeDispatch**: C forcibly calls the module's attached handlers before each write intent. binding.resource is that operation's frozen resource; subject is `{input:<entire frozen FlowSubmission>,operationId:<this write id>}`. Evidence must bind the pass to the operation before intent is authorized. Omitting a product hook.verify action cannot skip this exit.
- **afterResult**: the current driver does not invoke handlers automatically. When a module attaches afterResult, the product must first propose hook.verify with `{result:<final candidate>,operationId:<original terminal write id>}`, await its successful receipt and then separately propose delivery.propose. C requires actual successful Hook evidence for every terminal write and the canonical SHA of subject.result must match the delivered candidate. Missing evidence or changed content is EVIDENCE_INSUFFICIENT. Before/after select resources from actual provider operations in this task/revision, never the first JSONB entry. Other verify points refuse ambiguous multiple resources. No attached handler means no added default product rule.

Delivery and outcome-error actions must each be the sole action in their batch. `outcome.error.code` must already be registered in F. Product Tools cannot import Hub or register a code at execution time; an unregistered error action is refused by the contract. Hook rule code/facts remain product decision data, not a newly registered platform code. C separately projects worker error channels to registered codes while retaining the full original report in B.

All A2 budgets remain unchanged: state 256 KiB, input metadata 512 KiB, transition output 256 KiB, ordinary JSON strings 32 KiB, arrays/actions 256 items, depth 16, controlled decoded bytes 8 MiB, and actual Tool wire input 24 MiB/output 16 MiB. expectedOccurrences is the existing optional contract field; its absence is not permission to invent an occurrence. Full bytes appear in the frame needed for execution; lightweight preflight checks live authority/references without replacing the transition protocol with another shape.

### C-phase work: matching the gateway protocol

The following shapes were confirmed by the user and checked read-only against the local gateway source. Only keys, types and behavior are recorded, with no endpoints, configuration values or real receipts. This is not an implemented extension to ProviderPolicy and does not prescribe one universal receipt for all MCP services. The later C work must express differences through approved generic policy rather than product Tool names in Hub code.

| Gateway Tool / receipt | Native shape and constraint |
|---|---|
| `lease_acquire` | Request `{}`; returns lease_id:string, token:integer and expires_in_s:number. TTL is not expires_in or a duration invented by Hub |
| `lease_heartbeat` / `lease_release` | Current lease_id/token only; a successful release body includes released=true |
| `env_prepare` | Read Tool that requires lease_id/token; optional device_build. Without the expected build, build_checked=false is not verification of the bound build |
| `bed_topology` | Read Tool that requires lease_id/token; optional refresh:boolean |
| `case_submit` | Required xlsx_b64 plus lease_id/token, optional module. The byte parameter is not payload_b64; omitting module uses the gateway's configured default |
| `case_status` / `case_results` | Request **task_id only**. Their public inputSchema has additionalProperties=false and rejects extra lease_id/token |
| Normal successful submit | task_id, sha256, bytes, case_ids, deliver_epoch, submit_autoid and module; **no state and no echoed request_hash/input_sha256/byte_hashes** |
| Status receipt | **Still has state** (running/done/lost, etc.), task_id, rc and log_tail. It is incorrect to say every gateway raw receipt lacks state |
| Completed results | task_id, channel, rc, xlsx_sha256, cases and other result fields. The complete-result channel is ready; the current completed-results branch has no state or the three generic hashes. Incomplete/runner_lost branches may include state; do not fabricate one common set of fields across all branches |

Successful Tool wrappers still include ok=true, but ok cannot replace state/hash fields. channel=ready means the results channel is complete, not that every case passed. rc is the runner's exit fact; product interpretation still separates case/step verdicts from execution terminal facts.

Later C implementation must address distinct boundaries rather than weakening a synthetic fixture to keep it green:

1. **Per-Tool lease mapping**: the current generic worker appends the same lease object to submit/status/results/reconcile args, which is incompatible with the strict status/results schema. Policy must describe which calls receive lease fields and which receive only the remote task id. Products must not obtain tokens and construct that authority themselves.
2. **Injection and schema order**: C currently validates product args before a lease exists, while real case_submit requires lease_id/token. Admission must distinguish product parameters from declared worker-injected parameters, and the final injected args must satisfy the approved schema and actual wire limit. The schema must admit the real lease fields; removing remote required fields or widening additionalProperties is not a fix.
3. **Submit parameters and module policy**: an authorized workbook slot maps to xlsx_b64. Approved policy determines module's source, optionality and constraints. Renaming an ordinary string does not bypass B byte/SHA checks. This identifies the mapping requirement without defining future JSON keys or a worker ABI.
4. **Receipt and terminal mapping**: A3 currently requires successful observations with state and three generic hashes together. Normal gateway submit/completed-results receipts do not provide them. Future approved policy must use actual state or channel/rc observations, binding each stage's identity and original separately. It must not add fields to raw receipts or treat RPC metadata as echoed provider proof. State/channel/rc paths and decisions must be declared per Tool. query_error or missing_after_done cannot arbitrarily mean done or successful results; a separately proven status terminal cannot be rewritten by results-channel failure.
5. **Native evidence binding**: native 1.1.1 checks submit sha256 against the frozen workbook and case_ids against workbook case identities, then binds status task_id/state=done and results task_id/xlsx_sha256 to that submission. channel other than ready can remain partial. sha256/case_ids are this gateway protocol's mapping targets. Hub must use approved policy to check frozen-original SHA and case identities produced by an approved method; it must not hard-code APV fields or parse Excel in the generic driver. Exact predicates/schema remain later C design work. Compatibility must preserve these proven relationships rather than requiring absent generic hashes as the only evidence. This records existing behavior without authorizing native-byte changes or promoting whole-case conclusions to per-step passes.

The previous section records the later same-lease prepare/observation/beforeDispatch ordering before intent and submit. Ordinary reads currently acquire no remote lease; a module's bare env_prepare/bed_topology calls cannot resolve that gap. afterResult remains the user-confirmed explicit hook.verify plus delivery-evidence gate, not a new automatic call in this work list.

The C acceptance target is an entirely synthetic strict gateway with these shapes: required lease fields, task_id-only status/results, actual parameter names, submit without state, completed results without generic hashes, and status with state. C compatibility acceptance is skipped by default until that implementation work begins. When explicitly enabled against the current implementation it must produce reproducible failures; skip/todo is not a pass. Each implemented boundary may turn green only with RPC-argument, B-original and actual-dispatch-count checks. Passing A3's synthetic protocol proves that tested protocol, not this matching acceptance or real gateway/device integration. This round records work and acceptance targets only; it implements no future schema, changes no gateway and dispatches no real environment.

### C second-round work: run budgets and controlled-source gates

This section records C design work only. It changes no F constants, Hook action schema, driver or independent product module. The `5cdbc2b` / `6a8cb799` observations covered their old synthetic-provider-protocol path with workbook/command projections prepared outside the flow. The old `6a8cb799` positive path passing does not establish that the formal flow reads all controlled originals or that the second-round source, error and scale gates below are green. Strict matching cexg acceptance is separate; those observations are not production-compatibility proof.

The current arrayItems=256 bounds action batches/general JSON arrays, runOnce generation/total flow_steps and validateBatch's accumulated step keys. Batch size, transitions per run and total durable steps are different budgets. The existing 21-case numbers give 216 device commands + 21 host commands + 1 workbook verification = **238 verification subjects / Hook actions**. With two attached handlers per host subject, handler decisions total 216 + 42 + 1 = **259**, not 259 durable steps.

Let H be verification actions, O other durable actions and T Hub transitions. Total durable steps are `H + O + T`. The old schedule has H=238, O=5 (env/map/submit/parser/afterResult) and T=7: **250**. Optional topology observation plus its transition adds two: **252**. Reading workbook, command-check and function-contract originals with one Tool and one transition each adds six: estimated **256 / 258**. This is a reproducible estimate formed by adding three sequential original reads to the old schedule, not a measured new flow or an irreducible lower bound. Batched reads can change O/T. The current 256-step run leaves only six/four positions for that old schedule; a one-case pass does not prove batch capacity.

C should separately name and bound per-run steps. Keeping twice the maximum estimate gives `pow2ceil(2 * 258)=1024`. `pow2ceil(258)=512` instead leaves 254 positions and must not be called a twofold margin. Transition count needs its own schedule measurement: estimated T=7+1+3=11, so `pow2ceil(2 * 11)=32` is a candidate tier, not a universal product-flow capacity. Raising per-run counts does not raise the 256-item per-batch/JSON-array limit or any byte limit.

Increasing step counts alone is insufficient. frame.observations, expectedOccurrences and delivery references still allow at most 256 items each; metadata is still 512 KiB and Tool wire 24/16 MiB. C also needs bounded observation-window and controlled-original projection design, preserving historical B originals and exact references. Truncation must not claim completeness, conceal unverified work or discard unknown writes. Capacity and failure behavior require separate acceptance before constants are chosen; this round does not enlarge the contract.

The preferred option keeps one subject per hook.verify action and separates run counters with an explicit observation window. A subjects array on hook.verify is another option, but it is an F contract change, not an existing field. Each item would require actual task/revision, method/source/resource pins and operation association, stable item identity/input index and B evidence linking each actual decision to its index and digest. After the first block, only the processed prefix is observed; remaining items are unverified/not run, never pass. Full failure and partial receipts must retain originals and account for worst-case batch output bytes, handler count/order, timeout and heap bounds. One unbound batch binding cannot cover different resources, and partial passes cannot satisfy a full dispatch/delivery gate. Exact fields and partial-evidence protocol remain later C design; preserving the existing F action shape is preferred in this round.

The following roles are synthetic-wiring conventions, ordinary SourceArtifact.files.role strings rather than a platform product vocabulary. The old observations used workbook/command-tree/function-contract. command-check is a new second-round synthetic convention, not a claim that the old module consumes it:

| role / slot | Original and consumption boundary |
|---|---|
| `workbook` | Frozen workbook bytes. An approved pure Tool derives cases/device commands/host dispatches from B bytes; client pre-projection does not replace that read |
| `command-check` | Preserve the sync command_check return's result.ruleVersion/result.commands and actual sourceSha256. The formal flow checks bound input, build/source and command identities at their actual fields, then an approved method derives Hook booleans. Do not invent present:true; neither a role name nor upload approval proves a Tool call occurred |
| `command-tree` / `function-contract` | Frozen tree/contract bytes interpreted by approved product Tools, not Hub. command-check does not waive their required correspondence; role/slot names grant no read authority |
| `hub.result.<stepKey>` | Dynamic B-original slot generated by C for large JSON/overlong-string results, at observation.facts.result.original.slot/reference. frame rechecks authorization before adding bytes to controlledBytes. Small results can remain inline in facts.result; **not every Tool result has this slot** |

Tool byteSlots select actual current-frame slots and append bytes in order. Do not guess a dynamic slot, assume every result is inline, or treat an artifact id/download path as a slot. Interpretation must handle both small inline and original-pointer representations, verifying the actual SHA. Incomplete evidence stays unmapped; old projection-path success is not second-round acceptance.

Current error and binding facts remain precise:

- outcome.error's top-level code must be a registered platform code. The four APV Hook rule codes HOST_SET_UNDECLARED, HOST_NOT_IN_BED, COMMAND_NOT_LITERAL and HOST_COMMAND_OUTSIDE_POLICY are not directly usable top-level platform codes. Preserve them in product facts and then error.details (for example details.code), with a registered top-level code such as HOOK_FAILED. Product facts must not imitate a separate Hub error/resultError channel.
- receiptPolicy.inputSha256Path compares `canonicalHash(the entire FlowSubmission)`, not workbook SHA. A3's synthetic provider echoes input_sha256; the current real gateway does not. Renaming or substituting xlsx_sha256 cannot prove the complete-input digest.
- On provider refusal, the worker removes gatewayRefusal from error.details and retains the original in B as `{schema,tool,phase,refusal}`. After C hydration, small refusal text/data is the inner raw at observation.facts.result. Large representations use facts.result.original references; their B bytes still contain the envelope and must be read through refusal. A product state.errors record must use these actual fields/references, not assume ordinary worker error details contain the original. C may add separate interpretation facts for results failure after an independently proven terminal; that does not redefine every refusal receipt.

### Measurements and initial budgets

The maintainer supplied only numerical measurements from a real 21-case batch, without originals, real addresses or business fields. gateway-results was 149702 bytes: results 147339, environment 670, status 958 and submit 688. Topology was 9970, workbook 7209 and interpreted output 119582. Per-case UTF-8 logs had maximum 10234/total 106734 bytes; JSON-escaped logs maximum 10420/total 109125, up to 167 lines and longest line 127 bytes. There were 119 steps, 216 device commands, 21 host commands and 26 checkpoints; per-case maxima were 7 steps, 23 device commands, 1 host command and 2 checkpoints. Maximum JSON depth was 7 and maximum array length 216. command-check was 4219626 bytes, including two raw-base64 segments of 2577744 and 1527460; the remainder was 114422.

`pow2ceil(n)=2^ceil(log2(n))`. JSON-byte and depth budgets start with twice the measured size before rounding up to a power of two. Arrays use the measured largest array; controlled bytes use the stated original total. These are reproducible initial capacity choices, not a claim that one batch measures every valid workload:

| Budget | Formula | Initial ceiling |
|---|---|---|
| State JSON bytes | `pow2ceil(2 * 114422)` | 262144 (256 KiB) |
| Input metadata bytes | `pow2ceil(2 * 208866)` | 524288 (512 KiB) |
| Output protocol bytes | `pow2ceil(2 * 119582)` | 262144 (256 KiB) |
| Ordinary JSON string/key UTF-8 bytes | `pow2ceil(2 * 10420)` | 32768 (32 KiB) |
| Each array / action batch | `pow2ceil(216)` | 256 |
| JSON total depth | `pow2ceil(2 * 7)` | 16 |
| Controlled decoded total (also bounds one item) | `pow2ceil(149702 + 9970 + 7209 + 4219626)` | 8388608 (8 MiB) |

208866 is a **request estimate**: 38846 frozen source bytes plus 170020 parameter-JSON bytes, without source escaping or the actual envelope. 119582 is an interpreted file's size, not a measured stdout envelope. Neither estimate replaces actual wire validation. The measured sample contains Chinese and escaped characters, with zero NUL/other control bytes; contract cases check UTF-8 bytes, not merely character count.

Metadata includes all input except controlled contentBase64: binding, currentInput value/sha256, state, facts, identities and pointers. State is a sub-budget, not an additional allowance. Controlled base64 is not incorrectly refused by the ordinary 32-KiB string limit, but canonical encoding, decoded size, per-slot SHA and the 8-MiB decoded total still apply. XML/base64 from command-check stays in B rather than growing in transition state. The output budget covers the entire output, not an unbounded product of per-action allowances.

Every new sub-budget must also fit the existing Tool-host **24-MiB input / 16-MiB output** channel. Exact serialized wire includes frozen files, imports, base64, arguments and the whole UTF-8 envelope. `checkExecutionTransitionWire` accepts actual strings or Uint8Array and uses the intrinsic byte length rather than an arbitrary object's self-reported byteLength. Source-byte-plus-args estimates are insufficient. Individually valid budgets may still exceed the combined wire ceiling: refuse rather than truncate, enlarge production limits or fall back to an unisolated process.

B's 16-MiB upload limit does not make every Tool or slot capable of taking such an original. The 8-MiB decoded total, ordinary 32-KiB string limit and other budgets are not enlarged by byteArgs. Provider byte mapping uses verified B references, not a model copying uploaded content into args. Parsers that require full originals use bounded controlledBytes and cannot bypass byte-reading/wire checks through ref-only hashing.

The measured batch had **no sessions field**. This is neither a zero legal capacity nor proof that its real shape is covered. A2 adds no session/device-specific capacity assumption; controlled-byte and general JSON budgets apply. Over-budget interpretation is disclosed without changing a proven D terminal. Larger-result batching or range inputs require a separate design and acceptance.

Exported JSON Schema describes strict fields, action unions, arrays and string structure. UTF-8 total bytes, plain-object/cycle checks, canonical base64, decoded SHA and registered error codes also require the same contract parser. A2 synthetic contract checks alone are not Enforcement-chain, real-device or deployment acceptance.

## Appendix A3: generic driver and evidence boundary

The driver uses the existing task-submit path with the `module-execute` capability, not a product-name switch. C persists flow_runs/flow_steps: definition and state, step keys/request hashes, operations/fences, dispatch intent, original remote identity, original references and terminal facts. The worker runs frozen transition/Tool/Hook code through declared imports. Only the generic provider connector receives runtime profiles and injected credentials. operation.wait observes an existing operation in the current task/revision, never another remote write.

Providers use existing connector-instance, runtime-profile and credential assets. The approved `hub-provider/1` receiptPolicy declares Tool names, input/receipt schemas, states, identity/hash field paths, leases and pre-dispatch refusal paths. Hub checks mechanical receipt identity, not product workbook methods, device names or log regexes. Effect and minimumRole come from approved provides. The protocol fields are in the [driver contract](../../../packages/execution/src/flow-contracts.ts), and route-specific usage is recorded in the [client handoff](../../client-api-handoff.md#a3通用模块执行与受控原件).

Hub verifies B authorization, source pins, SHA and size before mapping byteArgs/byteSlots. Dispatch intent is durable before submission, and uncertain writes are not replayed as step retries. Unknown writes and failed reconciliation retain freezing; proven pre-dispatch failure and read timeout do not. An execution-is-change submission freezes actual Tool, parameter digest, original references and three pin groups and consumes its approved Change set only once.

The beforeDispatch exit and the current explicit afterResult receipt gate are described in A2's [driver-injected shape](#driver-injected-shape). A proven status terminal is recorded before results are fetched. Later result/interpretation failure keeps its cause and original; it does not use status as a result or invent successful rows. Provider parsed JSON is stored as canonicalJson bytes in B; worker event/report pointers are bound to operation/stage and C rereads them to verify size and SHA. Canonicalization is a stated transformation, not preservation of HTTP whitespace or field order. Small sanitized JSON projections and product interpretations remain distinct from originals.

The implementation identity covers the frozen module digest, flow, driver version and supported exact dependencies. Frozen files cover Tools, Hooks and relative dependencies. Historical approved pins and latest-approved reader intersections are checked again for execution; drafts do not change binding, new admission selects an explicit method, and old tasks do not upgrade automatically. Resource/runtime-profile revisions are pinned, and the existence of a file is not approval. C5 separates 1024 persistent steps from 256 generations and unchanged 256-item batches; overflow fails explicitly.

A3 acceptance requires the supported macOS seatbelt adapter, temporary PostgreSQL and synthetic providers. Separately frozen, approved and disabled synthetic modules prove the generic driver for those protocols only, not native APV migration, real devices/models or compatibility with every MCP server. Verification observations belong in [progress](../../server-s2-progress.md), not a claim of deployment in this design.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).

### C2: Approved ordinary and original-byte argument mappings

receiptPolicy.toolArguments maps Tool names and target parameter names to exactly `{literal: finite JSON}` or `{inputPath: [field path]}`. Input paths start at C's frozen whole FlowSubmission, for example `['value','build']`; they cannot read environment variables, profiles, credentials or transition state. C admission and D invocation independently derive the approved revision's arguments. Product args that shadow mappings are rejected. Undeclared Tools, prototype paths, accessors, cycles, non-finite values, strings over 32 KiB and other A2 budget violations are rejected.

receiptPolicy.byteArguments maps each wire parameter to its logical action.byteArgs parameter, for example `{case_submit:{xlsx_b64:'workbook'}}` for `byteArgs:{workbook:'workbook'}`. Existing actions that already use xlsx_b64 need no mapping. A mapping must cover every logical original exactly once, without omission or duplication; ordinary parameter or lease-authority collisions are rejected. C's request hash still binds the original action and authorized B references. D reads original bytes at invocation, and wire byteBindings and receipt checks use the mapped parameter names. Ordinary JSON string limits are not enlarged for workbooks.

status/results/reconcile receive the persisted remote identity through taskIdArgument and only the lease parameters explicitly mapped for that Tool. Use empty argumentsByTool entries for Tools accepting only task_id. Submit-only module/base64 and undeclared lease fields do not leak into observation calls.

### C3: Stage-specific provider receipt verification

`receiptPolicy.receipts` declares separate submit / status / results / optional reconcile rules with receiptSchema, remoteIdPath, optional sha256Path / caseIdsPath, and completion. Completion is `{path,runningValues,terminalValues,rcPath?}`: the path may select state, channel or a finite integer rc, and the approved running/terminal sets are disjoint. Runner exit facts or ready do not imply passing individual cases. Without receipts, the complete legacy echo protocol remains. The new protocol does not require nonexistent request_hash / input_sha256 / byte_hashes or substitute a workbook SHA for the whole FlowSubmission digest.

The new mode requires approved `identityProjection:{stepId,path,export,byteArgument,sha256Path,caseIdsPath,idPath?}`. byteArgument is the mapped wire parameter. Before intent, C verifies this revision's successful tool.call action, frozen method pin, request digest, controlled-original references and B projection bytes, proving the Tool received the same original. C derives identities from those bytes rather than caller values. Migration 42 stores receipt_facts with the projection reference, operation, method, original SHA and identities; this is not a remote_identity. Submit must check SHA/identities and results must check SHA, while subsequent stages bind the persisted remote task identity. Historical reports reverify frozen proof without granting new authority.

D preserves each successful raw receipt by SHA before stage verification, retaining mismatches as unverified originals. After submission, observation/heartbeat refusal remains unknown without release or replay. A proven status terminal is durable before result interpretation: results refusal or a wrong SHA affects interpretation, preserving the terminal and release facts. Approved product methods may deliver partial for an incomplete results channel without inventing device verdicts. The native 1.1.1 path is unchanged.

### C4: Same-lease preparation and the dispatch gate

Approved receiptPolicy may declare `prepare:[{tool,args?}]`. Every Tool must be uniquely declared as read in resource provides; arguments use toolArguments and per-Tool lease mappings, and the protocol's minimum-role checks include preparations. Within the write operation's acquire / heartbeat lease, the worker invokes them in approved order and persists canonical JSON originals by SHA, size and pointer. Preparation does not create a submitted identity.

Migration 43's prepare_ref binds operation, input revision, fence, request digest, resource pin, lease digest, order, actual argument digests and original references. C independently reads B and recomputes bindings before running beforeDispatch with `{input,operationId,preparations:[{index,tool,reference,result}]}`. Hook projections remove credential/lease fields and NUL, marking sanitized, while B retains originals; secrets and NUL do not enter JSONB. Excessive Hook JSON fails explicitly rather than truncating into a pass. The dispatch proof binds the new preparationDigest/fence, and intent checks the same leaseDigest; an older proof cannot waive fresh observations.

Preparation failure, revocation or Hook blocking before intent fails without submission or an unknown freeze. Local cancellation still does not prove remote stopping. Cleanup may only use this run's previously obtained credential to invoke its approved lease_release, granting no new dispatch authority. Plaintext-exception cleanup transport metadata is still checked against the frozen runtime revision and permanently audited/evidenced. Failed release remains false. Uncertain dispatched writes are not cleaned up or replayed; native 1.1.1 is unchanged. The module's earlier independent read, the write-lease preparation and the gateway's own submit-time check are separate observations.

### C5: Run capacity, observation windows and structural projection

Run limits are separate: 1024 persistent steps and 256 transition generations, while action batches and ordinary JSON arrays still allow 256 items. The 1024 limit rounds up twice the 258-step estimate for 21 cases; 256 generations retain the previous general limit rather than promoting the earlier schedule-specific estimate of 32 to a platform default. Replayed keys do not consume new capacity; an over-limit batch is rejected atomically without dispatching its prefix.

Only modules declaring `historyMode:"controlled"` may use overflow history. Optional observationWindow / expectedOccurrenceArchive metadata is `{total,returned,complete,archive?:{slot,reference}}`. C freezes complete B artifacts by SHA and supplies real `flow-history` / `flow-occurrences` controlled slots within the same 8-MiB decoded total. Inline windows contain at most 256 entries and retain intent, unknown, consumed authorization and active steps. Active records without worker returns explicitly say hub-step-ledger, never provider result. More than 256 critical records fails closed; 1024 does not promise arbitrary write history can be inline. Older modules without this protocol also fail explicitly at overflow.

All originals retain current B visibility, SHA and size checks; equal slot names may be reused only with equal roles/references. Light preflight preserves both input-revision hashes, frozen request references and source authorization. Delivery checks full task/revision observations and C-generated historical B bindings, then B ACLs, accepting legitimate older references without permitting hidden or foreign-revision objects.

Structural projection checks 256-KiB bytes, 32-KiB UTF-8 strings/keys, 256-item arrays and the actual 16-level frame wrapper. Even a small 257-item result uses the existing hub.result original slot. Result depth starts at 5 and error metadata at 6; omitted metadata discloses SHA/size/reason and the original worker report remains retained. Limits are unchanged and originals are not silently truncated. Product interpretation remains module-owned; native 1.1.1 bytes are unchanged.

The earlier C work-list sections retain pre-implementation protocol observations. Current behavior is defined by C1–C5 and the driver schemas above; strict synthetic acceptance is not live deployment.

Current ordinary reads acquire a temporary lease only when explicitly declared by lease.argumentsByTool. Approved prepare runs within the write lease after acquire, with fresh beforeDispatch verification before intent; the earlier bare-read examples do not authorize product-owned lease arguments.

### C1: Per-Tool lease injection and schema checks

`receiptPolicy.lease.argumentsByTool` maps Tool names to `{idArgument?,fenceArgument?}`. Empty or absent entries inject nothing; absence of the whole mapping preserves legacy global names. Targets must exist in an approved Tool schema and cannot collide with ordinary, byte, remote-identity or other lease fields. Acquire cannot inject an identity not yet obtained.

C admission defers only the approved injected fields' presence constraints while validating other fields. Unsupported top-level combination/cross-field schemas fail closed rather than having constraints erased. D fully validates approved schema/wire after filling the actual lease, approved ordinary mappings and controlled bytes. Explicitly lease-bound reads temporarily acquire/read/release and check all helper roles; empty status/results mappings carry only their declared remote identity.

C5 ledger/B bindings require consistent database locking: task → run → operation/step for generic flows. Claim skips a locked task instead of holding an operation while waiting upward. Store-shared flow lock callbacks cover both executor wrappers, heartbeat and expiration instances; native paths without a callback acquire no extra flow lock. Serialization does not replace identity, scope, fence, deadline or source authorization. Progress does not rely on deadlock retries.


### Failed Tool observations and empty successful results

Every failed C observation has `facts.error`, retaining bounded `{code, registered:true, message, details}`. `registered` states only that the projected platform code belongs to F's registry; it does not prove the reported cause or device effects. An unregistered reported code becomes `INTERNAL_ERROR` with `reportedRegistered:false`; the arbitrary original code remains only in B's complete worker report. When error details exceed the metadata budget, only `details` becomes a SHA/size/omission-reason summary, preserving the classification. An overlong message uses a bounded explanation while the original error remains verifiable in B. A failed report lacking error receives `INTERNAL_ERROR` with `details.missingError:true`, explicitly disclosing missing evidence without guessing a cause. A successful Tool returning `{}` remains an empty success without a failure error. These projections do not change report bytes, fences, effect classifications or an independently verified D terminal.


### Ordinary result reads after independent reconciliation

An ordinary read-only provider action calling the approved policy's `resultTool` first requires a unique proven-terminal write in the same task, input revision, resource pin and remote id. C generates and persists an internal `resultBinding` freezing the parent operation id, original request/input hashes, complete byteHashes, original-projection proof and real submitted/terminal B-original hashes. The read action's own hash and empty byteArgs never replace the write identity. The worker and C report independently validate `receipts.results`, retaining legacy echo compatibility. A reconciled parent observation may supply its independently verified terminal-status original, but its bytes and SHA must still be checked. Older runs lacking a real submitted-original proof, unknown writes without independent reconciliation, ambiguous associations and cross-task/revision/resource references fail closed; current input.value cannot manufacture evidence.

A wrong SHA, remote id or association that becomes invalid before reporting produces a failed read with retained originals and a bounded registered error. It does not freeze resources, repeat the write or give the read a D terminal. A parent interpretation gap is appended only after its proof is reverified. C retains the complete gap history by SHA in B; the parent carries a bounded summary, count and real artifact reference, reloading and deduplicating prior gaps without replacing terminal originals or lease-release facts. The product transition still proposes partial delivery through the delivery gate; the platform does not fabricate successful cases.

Initial dispatch and C reporting read and verify complete original bytes. Lightweight preflight with an existing binding rechecks parent metadata, partition, pins, state, remote id, request/original references and binding digest without reading B bytes or caching live authorization. `sourceByteProofSha256` is the original SHA for a single byte original/projection; in a multi-byte-hash legacy echo it is the map digest, with every original hash still retained.
