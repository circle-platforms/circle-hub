---
permalink: /design/en/truth-docked-architecture/
nav_order: 1
---

# Truth-Docked Architecture: A Critical Refutation of Prior Platform Designs and the Theoretical Reconstruction of Enterprise Agents

This specification conducts a systematic self-critique and refutation of the prior design specifications formed during the evolution of the Circle platform—including the `B/C/D/E` four-object by five-element matrix, the pure deterministic `hub-execution-transition/1` state machine, the `harness-primitives` four-primitive and five-fixed-hook model, the `approvals-and-enforcement` change-set-only dogma, the early `knowledge-v1` probabilistic assessment model, and the closed-world assumptions of the early Excel compilation theory—and establishes the foundational theory and core architecture of the platform from first principles.

This document omits generic industry commonplaces (multi-agent orchestration, prompt engineering, vector RAG chunking, standard RBAC, or thin MCP wrappers) and records only the original theoretical laws and architectural invariants forged across four generations of production engineering and failure forensics.

---

## 1. First Principles: The Triadic Contradiction under Irreversible Cost

Consumer coding agents are built on a **Low-Cost Trial-and-Error Assumption**: the model edits files directly, runs local commands, and simply retries when a mistake occurs. In high-consequence enterprise production—whether pushing configurations to shared hardware testbeds and compiling delivery workbooks, calculating financial statements and ledger entries, deploying live load-balancer/firewall policies, or diagnosing and backporting source-code patches across dozens of customer release branches—that assumption collapses completely.

Enterprise agent deployment is governed by a single physical constraint: **downstream target systems have zero tolerance for hallucination, and any error that penetrates into production or a formal deliverable incurs massive, cascading, and often irreversible cost.** Writing one wrong number in a financial ledger, pushing one wrong command in a device configuration, merging a patch into the wrong release branch, or omitting a single teardown line in a shared testbed workbook are mathematically isomorphic instances of the same problem.

Under this constraint, the defining problem of an enterprise agent platform is neither "how to connect more tools" nor "how to register more assets in tables," but how to resolve the coupling and tension among **three structural domains**:

1. **The Stochastic Generative Domain ($\mathcal{S}_{\text{gen}}$)**: Large language models parse unstructured human intent, open-ended business requirements, and cross-modal context. Their outputs are inherently probabilistic ($\sim P_\theta(y \mid x)$), and their autoregressive token stream is physically a **lossy, noisy channel**.
2. **The Repeatable System Ground-Truth Domain ($\mathcal{O}_{\text{sys}}$)**: Existing enterprise source code ASTs, Git commit DAGs, appliance command trees (`cmdtree`), database schemas, financial accounting identities, sandbox compilers, and live hardware testbeds constitute **100% deterministic, repeatable Ground-Truth Oracles**.
3. **The Intermediate Transformation, Zero-Transcription Docking, and Epistemic Storage Layer ($\mathcal{I}_{\text{trans}} \bowtie \mathcal{K}_{\text{store}}$)**: Confining stochastic LLM output to a strongly typed Intermediate Representation (IR), assembling ground-truth values into target artifacts via zero-transcription pointers, rejecting hallucinations and false positives through repeatable truth valuation operators, and persisting verified truths and transformations as computable epistemic state.

**The entire value of the Platform lies in serving as the deterministic third layer—transformation, zero-transcription docking, and repeatable truth valuation—between the stochastic generator and the zero-tolerance target system.** If a platform governs outer accounts, tables, file hashes, and approval tickets while failing to close the loop of intermediate transformation, repeatable truth valuation, and epistemic storage inside its core, the framework itself is wrong.

---

## 2. Six Fundamental Refutations of Prior Platform Designs and Early Theory

Measured against these first principles, our existing platform documents ([Object standard and data flow](object-standard.md), [Execution flow migration into product-line packs](execution-flow-packs.md), [Harness primitive specification](harness-primitives.md), [Approvals and the enforcement chain](approvals-and-enforcement.md), and [Levels and elements](levels-and-elements.md)) and archived designs suffer from six structural fallacies:

### Refutation 1: Against the "Four Objects (`B/C/D/E`) × Five Elements" Administrative Taxonomy — Mistaking an Asset Registry for a Truth Compiler

- **Prior Claim**: [Object standard and data flow](object-standard.md) partitions the platform into four symmetrical objects (`B Knowledge / C Work / D Execution / E Method`), forcing each to consist of the same five administrative facets (`Record, Asset, Approval Policy, Evidence, Extension Point`) to match a uniform five-box UI registry ([Levels and elements](levels-and-elements.md)), and mandates a 10-step linear pipeline (`1. A submits → 2. C accepts → ... → 9. A retrieves`).
- **Architectural Critique**:
  1. **The Core Intermediate Transformation and Truth-Valuation Layer Disappeared**: The `B/C/D/E × 5 Elements` matrix is an **IT Asset Compliance Registry Taxonomy**. It focuses on hashing files, approving registrations, and paginating tables. Meanwhile, the decisive computational loop—**LLM emits Domain IR $\to$ Deterministic Compiler docks truth pointers $\to$ Multi-stage Truth Oracles evaluate soundness and emit structured counterexamples**—has no first-class home in `B/C/D/E`. It was fragmented across unmanaged client-side scripts (`Skill/scripts/`), post-submission server functions (`tools/*.ts`), and rigid hooks (`hooks/*.ts`).
  2. **UI-Driven Architectural Inversion**: [Levels and elements](levels-and-elements.md) attempts to constrain all engineering work into five fixed page levels, four diagram types, and twelve CRUD verbs. Real product-line engineering revolves around cross-version code diagnosis, configuration synthesis, workbook compilation, and root-cause attribution—not clicking `register, upload, push, new version, retire` across four administrative registries.

### Refutation 2: Against the "Open-Loop Handoff + Pure Deterministic FSM (`hub-execution-transition/1`)" Split — Severing Generative Hypotheses from System Counterexamples

- **Prior Claim**: [Object standard and data flow](object-standard.md) and [Execution flow migration](execution-flow-packs.md) assume the client session (`A`) hands off a finished submission (`FlowSubmission`) in one shot, after which the server advances exclusivamente via a model-free, network-free pure reducer `transition(frame) -> {state, actions}`; any verification failure drops the task into `waiting-input` for human editing or `failed`.
- **Architectural Critique**:
  1. **The False Dichotomy between Generation and Execution**: An open-loop handoff works only if the artifact submitted by `A` is already 100% compiled and verified on the client. Consequently, **the hardest loop—Generation $\to$ Transformation $\to$ Static Truth Valuation $\to$ Counterexample Repair—was not running on `circle-hub` at all**, but degraded into ad-hoc local shell scripts inside the client workspace, reducing the server to a batch job queue.
  2. **Inability to Carry Iterative Product-Line Tasks**: Source-code root-cause analysis, live troubleshooting, cross-version configuration migration, and financial reconciliation cannot be expressed as a static JSON state machine with predetermined step order. They are **Guarded Fixed-Point Iterations**: the generator proposes a candidate IR or diagnostic probe $\to$ the platform compiler binds system truths and executes the probe or static oracle $\to$ the oracle returns a **Deterministic Counterexample** pinpointing the exact AST node, CLI parameter, or ledger cell $\to$ the generator repairs the IR until $\text{Sound}(x, \sigma) = \text{True}$. Trapping generation on the client and execution in a rigid server FSM destroys closed-loop convergence.

### Refutation 3: Against the "Knowledge `B` = Byte Blobs + `semantic=not-asserted` + `Jev` Probabilistic Scoring" Model — Abandoning 100% Deterministic System Truth

- **Prior Claim**: [Object standard and data flow](object-standard.md) marks script-extracted claims as `origin=script, semantic=not-asserted` ("proving only literal content and structure"), while early `knowledge-v1` modeled all knowledge as uncertain `Claims` scored probabilistically (`Choice/Score/Noul`) by a small model (`Jev`).
- **Architectural Critique**:
  1. **Reducing Deterministic Engineering Truths to Literature RAG**: While prose manuals, meeting notes, and tickets suffer from ambiguity and drift (normative declarations $\mathcal{K}_{\text{ought}}$), the core assets of an engineering enterprise—**source code ASTs and call graphs, Git commit DAGs, appliance command trees (`cmdtree.xml`), configuration parser structs, financial reconciliation identities, and database schemas**—are **100% deterministic, computable ground truths ($\mathcal{K}_{\text{is}}$)**.
  2. **Using Probabilistic Models to Guess Deterministic Facts is Architectural Malpractice**: Whether a bug-fix commit is reachable from a customer release tag, which C struct field and validation macro implement a CLI command, or whether a multi-sheet financial ledger balances has a single, 100% deterministic answer. Labeling these `semantic=not-asserted` or scoring them with `Jev` discards repeatable ground-truth valuation and regresses to fragile document RAG.
  3. **Reconstructing Knowledge (`B`)**: The knowledge engine must not be a passive file drive or probabilistic snippet index; it must be an **Executable Truth Substrate** that compiles existing source code, version graphs, command trees, and schemas into **Computable Truth Oracles**.

### Refutation 4: Against the "Four Harness Primitives & Five Fixed Hooks (`harness-primitives.md`)" Model — Catering to Consumer Toy Primitives Above while Hardcoding Excel Below

- **Prior Claim**: [Harness primitive specification](harness-primitives.md) defines the method layer (`E`) as governing consumer coding-agent files (`SKILL.md`, `CLAUDE.md`, `Agent`, `Command` across Claude Code, Codex, and Cursor) while hardcoding exactly five global hook events in the platform core: `verify.deviceCommand`, `verify.hostCommand`, `verify.workbook`, `beforeDispatch`, and `afterResult`.
- **Architectural Critique**:
  1. **Soft at the Top (Mistaking Prompt Files for Enterprise Methods)**: Consumer `SKILL.md` and `CLAUDE.md` files are uncontracted natural-language prompts. Across four generations of systems, we proved that markdown instructions asking an LLM "not to hallucinate commands, not to mis-copy numbers, and not to forget teardown" fail predictably on long horizons. The first-class method primitive of an enterprise platform is not a `SKILL.md` folder, but a **Guarded Domain Morphism (`Domain IR Schema + Zero-Transcription Emitter + Repeatable Truth Oracle Chain`)**.
  2. **Brittle at the Bottom (Excel-Specific Hooks Hardcoded as Universal Core)**: Declaring that "Hub core contains zero product logic" while hardcoding `verify.workbook`, `verify.deviceCommand`, and `{client, contract:{testEnvEnabled:[…]}}` into the core Hook contract mistakes a single task ("Excel-driven network appliance testing") for a universal platform abstraction. When applied to C source-code patching, version lineage verification, financial accounting, or live configuration deployment, those five hooks become an immediate straitjacket.

### Refutation 5: Against the "Approval Only on Change Sets, Never at Runtime (`approvals-and-enforcement.md`)" Dogma — Conflating Logical Truth with Irreversible Blast Radius

- **Prior Claim**: [Approvals and the enforcement chain](approvals-and-enforcement.md) asserts: "There is only one approval concept: the Change set... At runtime there is no approval, only the Enforcement chain... When a production device needs the two-person rule, the resource declares `executionIsChange: true`."
- **Architectural Critique**:
  1. **Conflating Epistemic Soundness with Consequence Irreversibility**: The observation that "an approver cannot make a command appear in the tree or turn a device into another build" proves that **humans must never approve logical falsehoods (humans cannot replace Truth Oracles)**. It does *not* imply that runtime actions with irreversible consequences need no authorization.
  2. **Static Method Approval Cannot Bound Dynamic Runtime Blast Radius**: Using the exact same approved method module on the exact same approved appliance, deploying an isolated test virtual server with a verified inverse teardown block vs. executing `no slb virtual` on a live production service (or merging a patch into a customer release branch) both pass 100% of syntax and build checks—yet the former is completely reversible while the latter causes irreversible production damage.
  3. **The Blunt `executionIsChange: true` Resource Flag**: Tying two-person approval to a static boolean on the resource either forces every harmless diagnostic probe and reversible sandbox test on that resource through heavyweight asset change-set approval, or lets destructive but syntactically valid commands pass unchecked. **True governance depends neither on "registration time vs. runtime" nor on a coarse resource boolean, but on the computed State Diff ($\Delta\sigma$) and Reversibility Class of the specific operation.**

### Refutation 6: Self-Critique of the Early "Closed-World Excel Compilation Theory" — From Forward Table Compilation to Dynamic Multi-Oracle Reconciliation

- **Prior Theory**: Early research established the orthogonal entropy decomposition $\varphi: \mathcal{I} \to G \sqcup E \sqcup V$ and the soundness triple conjunction $\text{Sound}(C) \equiv (P \vdash D) \wedge (\varphi(D) \subseteq \text{closure}(E)) \wedge (R^*(P, \text{ctx}) \models E)$.
- **Self-Critique and Elevation**:
  1. **Breaking the Stationary Closed-World Assumption**: Excel compilation converged over a static, finite closed set (`cmdtree.xml` with 3,186 commands and a 29-column workbook contract). Full product-line engineering operates over a **high-dimensional, evolving directed graph $\mathcal{K}_{\text{is}}(\sigma_v, t)$** of continuous Git commits, diverging customer branches, and shifting runtime states.
  2. **Unifying Forward Compilation with Inverse Attribution and Cross-Oracle Equivalence**: Daily engineering encompasses not only forward synthesis ($\mathcal{I} \to \mathcal{A}$), but also **Inverse Attribution** (given failure observations $E_{\text{obs}}$, solving for the minimal root-cause path $c^* \in \mathcal{K}_{\text{is}}^{\text{code}} \times \mathcal{K}_{\text{is}}^{\text{git}}$) and **Cross-Oracle Equivalence** (proving that a C AST patch, a CLI command node, a configuration diff, and a workbook assertion denote the exact same state transition under version anchor $\sigma_v$).

---

## 3. Theoretical Reconstruction: Four Formal Theorems and Axiom Systems

Stripped of superficial conventions, the theoretical foundation of the Circle platform rests on four formal laws:

### Theorem 1: Generalized Orthogonal Entropy Decomposition & Zero-Transcription Channel Theorem

Let $\mathcal{A}$ be the target deliverable or system operation sequence of any high-consequence enterprise task given unstructured intent $\mathcal{I}$. If an LLM generates the raw bytes or command stream of $\mathcal{A}$ directly, its conditional entropy decomposes into three coupled terms:
$$H(\mathcal{A} \mid \mathcal{I}) = H(G_{\text{struct}}) + H(E_{\text{bind}} \mid G_{\text{struct}}) + H(V_{\text{sem}} \mid G_{\text{struct}}, E_{\text{bind}})$$
where:
- $G_{\text{struct}}$ is the **mechanical structural skeleton, syntactic framing, teardown symmetry blocks, and format contract** of the target system;
- $E_{\text{bind}}$ is the set of **exact environment and context bindings** that must match external truths byte-for-byte (testbed topology IPs/ports, exact ledger figures, real source file paths and AST symbol names, Git commit SHAs, raw `\r\n` device transcripts);
- $V_{\text{sem}}$ is the **minimal semantic parameter space** requiring genuine intent decomposition and reasoning.

Furthermore, for any deterministic ground-truth string $e \in E_{\text{bind}}$ of length $L$, passing $e$ through an autoregressive token channel with per-token transcription error rate $\epsilon > 0$ yields a non-zero corruption probability $P_{\text{corrupt}}(e) = 1 - (1-\epsilon)^L > 0$.

**[First Law of Truth-Docked Compilation]**: The platform must enforce orthogonal decoupling via a typed Domain IR and a Zero-Transcription Pointer Channel:
1. **Structural Entropy Elimination ($H(G_{\text{struct}} \mid \text{IR}) \equiv 0$)**: The LLM never emits target artifact $\mathcal{A}$ directly; it emits only a declarative $\text{IR}$, while $G_{\text{struct}}$ is expanded deterministically by the compiler $\text{Emit}(\text{IR})$.
2. **Binding Entropy Elimination & Zero-Transcription Isolation ($H(E_{\text{bind}} \mid \text{Pointer}) \equiv 0, \; P_{\text{corrupt}} \equiv 0$)**: Every ground-truth value $e \in E_{\text{bind}}$ is encapsulated as a content-addressed opaque pointer (`OpaqueRef` / `byteSlots` / `savedAs`). The LLM references only symbolic pointer names in $\text{IR}$, while exact numbers, topologies, source slices, and raw payloads are spliced directly into the target artifact at the byte level by $\text{Emit}$, **physically bypassing the LLM token output channel**.
3. **Semantic Entropy Minimization ($\min H(V_{\text{sem}})$)**: The LLM's generation space is confined strictly to low-entropy semantic slots $V_{\text{sem}}$, bounding single-step error below the convergence threshold of repeatable truth valuation.

---

### Theorem 2: Algebra of Repeatable Ground-Truth Valuation & Three Anti-Vacuity Axioms

**Definition (Repeatable Truth Valuation Operator $\mathcal{V}_{\text{truth}}$)**: Given a pinned system state and version coordinate $\sigma \in \Sigma_{\text{sys}}$, an operator $\mathcal{V}_{\text{truth}}(\mathcal{A}, \sigma) \to \langle \text{Verdict} \in \{\text{True}, \text{False}, \text{Unknown}\}, \; \text{Receipt}, \; \text{Counterexample} \rangle$ is a **Repeatable Truth Valuation Operator** iff it is executed entirely by deterministic code (zero LLM inference) and produces identical verdicts and machine-localizable counterexamples across arbitrary replays under $\sigma$.

To prevent false positives ("vacuous truth"), every truth valuation chain must satisfy three axioms derived from production forensics:

1. **Axiom 2.1: Non-Vacuity & Anti-False-Positive**
   - **Self-Echo & Error-Echo Stripping**: Output-matching oracles must strip echoed input commands and apply a deterministic veto dictionary against target-system error strings (`Invalid`, `Error`, `Unknown command`) so loose regexes cannot match failure messages as passes.
   - **Byte-Exact Replay**: Pre-execution assertion checks must replay against raw `byteSlots` preserving exact line endings (`\r\n` vs. `\n`) rather than JSON-normalized strings.
   - **Mutation Adequacy**: For any synthesized assertion $E_{\text{assert}}$, injecting controlled negative mutations $\mu(\text{Output})$ must produce at least one falsifying instance $E_{\text{assert}}(\mu(\text{Output})) = \text{False}$; assertions that evaluate to `True` under all mutations are rejected as tautologies.

2. **Axiom 2.2: External System Truth Supremacy (The `dongkl` Law)**
   - **Forensic Origin**: In the `dongkl` regression, deliverables that had already passed 100% of real appliance execution were revoked by overly rigid internal formatting heuristics (e.g., step-vs-bundle timestamp ordering and contiguous step numbering), causing delivery to regress from 27/34 to 22/34.
   - **Formal Law**: Let $\mathcal{L}_{\text{target}}(\sigma)$ be the true acceptance language of the target system and $\mathcal{R}_{\text{gate}}(\sigma)$ be the rejection set of the intermediate static gate. The static gate must be a **sound under-approximation of target rejection**:
     $$\mathcal{R}_{\text{gate}}(\sigma) \subseteq \overline{\mathcal{L}_{\text{target}}(\sigma)}$$
     Internal gates may reject only artifacts guaranteed to fail on the target system or violate physical safety invariants; internal stylistic heuristics must never revoke or downgrade an artifact that holds a verified target-system truth receipt ($\mathcal{O}_{\text{live}} \models \text{True}$).

3. **Axiom 2.3: State Teardown Symmetry (`OBSERVE_EXIT`)**
   - On any stateful shared system, forward assertion success is insufficient. Full soundness requires proving state restoration after teardown:
     $$\text{Sound}_{\text{state}}(\mathcal{A}, \sigma_0) \equiv \big(\sigma_0 \xrightarrow{\text{apply}} \sigma_1 \models E_{\text{assert}}\big) \;\wedge\; \big(\sigma_1 \xrightarrow{\text{teardown}} \sigma_2 \models (\sigma_2 \equiv_{\text{domain}} \sigma_0)\big)$$
     Any operation sequence that fails to prove post-teardown state equivalence is rejected as state pollution.

---

### Theorem 3: Epistemic Stratification & Computable Truth Ontology

To eliminate the conflation between deterministic system facts and lagging prose documentation, the platform partitions knowledge storage ($\mathcal{K}_{\text{store}}$) into five strata governed by a strict **Epistemic Authority Partial Order ($\succ$)**:

$$\mathcal{K}_{\text{is}}^{\text{live}} \;\succ\; \mathcal{K}_{\text{is}}^{\text{code}} \;\succ\; \mathcal{K}_{\text{receipt}} \;\succ\; \mathcal{K}_{\text{ought}} \;\succ\; \mathcal{K}_{\text{hyp}}$$

| Stratum | Symbol | Definition | Ingestion & Construction | Role in Transformation & Valuation |
| :--- | :--- | :--- | :--- | :--- |
| **Stratum 0: Live Runtime Truth** | $\mathcal{K}_{\text{is}}^{\text{live}}$ | Real-time state, topology, and raw transcripts observed on the target system under an active `fencing_token` | Captured by fenced probes and sealed by SHA-256 | Highest authority; overrides any conflicting static assumption or outdated manual |
| **Stratum 1: Code & Structural Formal Truth** | $\mathcal{K}_{\text{is}}^{\text{code}}$ | Version-pinned `(product, version, commit_sha)` source ASTs, call graphs, Git commit DAGs, `cmdtree.xml`, and database/ledger schemas | **Extracted exclusively by Deterministic Truth Projectors ($\Pi$) from authoritative repositories and build artifacts**; zero LLM involvement, confidence $\equiv 1.0$ | Serves as the **L1 Static Truth Oracle**: executes boolean `TRUE/FALSE` rulings on every CLI command, symbol name, struct field, version lineage, and formula |
| **Stratum 2: Verified Closed-Loop Receipts** | $\mathcal{K}_{\text{receipt}}$ | Historical `<IR, ArtifactHash, SignedReceipt>` triples that passed all truth valuation stages | Written atomically by the platform kernel upon oracle completion or `reconcile` | Provides verified compilation exemplars and cross-round flip detection |
| **Stratum 3: Normative Specifications** | $\mathcal{K}_{\text{ought}}$ | Product manuals, PRDs, design specifications, accounting standards, and issue descriptions | Imported from versioned source artifacts | Supplies business intent context; **whenever $\mathcal{K}_{\text{ought}}$ conflicts with $\mathcal{K}_{\text{is}}^{\text{code}}$ or $\mathcal{K}_{\text{is}}^{\text{live}}$, the authority reconciler rules in favor of $\mathcal{K}_{\text{is}}$ and emits a `SpecDriftRecord`** |
| **Stratum 4: Candidate Hypotheses** | $\mathcal{K}_{\text{hyp}}$ | Newly discovered pitfalls, patterns, or root-cause hypotheses proposed during task execution | Submitted as isolated candidates | **Never used directly as truth oracles**; promoted to $\mathcal{K}_{\text{ought}}$ only after attaching reproducible $\mathcal{K}_{\text{receipt}}$ evidence and passing independent review |

---

### Theorem 4: Reversibility Algebra & State-Diff Governance Law

Replacing the static "registration-time vs. runtime" dogma and the blunt `executionIsChange` resource boolean, the platform governs every external operation $op$ according to its computed **State Diff ($\Delta\sigma$)** and **Reversibility Class**:

| Reversibility Class | Formal Criterion | Enterprise Examples | Mandatory Kernel Governance |
| :--- | :--- | :--- | :--- |
| **Class 0: Pure / Observational** | $\Delta\sigma \equiv \emptyset$ (no mutation of shared external state) | Compiling IR to `.xlsx` bytes, L1/L2 static & sandbox truth valuation, read-only `show` probes, AST/Git graph queries, trial ledger calculations | **Zero approval, zero write lease**: runs automatically at high frequency inside isolated sandboxes; timeouts fail cleanly without freezing resources |
| **Class 1: Fenced Reversible Side-Effect** | $\Delta\sigma \neq \emptyset$, confined to an isolated resource under a monotonic `fencing_token`, with a **statically verified inverse operator $op^{-1}$ satisfying Axiom 2.3 (`OBSERVE_EXIT`)** | Running a workbook with verified `EXIT` teardown blocks on a leased testbed; applying a patch and running regression suites in an isolated Git worktree | **Zero runtime human approval; governed by hardware-fenced enforcement**:<br>1. Verify static truth receipt + completeness of $op^{-1}$;<br>2. Dispatch $op \circ \text{assert} \circ op^{-1}$ under monotonic `fencing_token`;<br>3. If $\sigma_{\text{post}} \equiv \sigma_{\text{pre}}$, release and deliver;<br>4. **On lease loss, timeout, or teardown failure, transition immediately to `unknown` and freeze the resource (`frozen = true`) with zero automatic retry** until out-of-band `reconcile` |
| **Class 2: Irreversible / High Blast-Radius Side-Effect** | $\Delta\sigma \neq \emptyset$ with **no inverse operator ($op^{-1} = \bot$)**, or targeting production network elements, formal financial ledgers, customer release branches, or shared truth baselines | Deploying live appliance configurations, posting formal financial journal entries, merging patches into release branches, installing/upgrading platform truth projectors | **Mandatory "Truth Valuation First, State-Diff Two-Person Authorization Second"**:<br>1. Complete 100% L1 static valuation and L2 dry-run simulation to compile an immutable **State Diff & Blast Radius Manifest ($\Delta\sigma$)**;<br>2. Two-person independent sign-off binds the exact triple `(InputRevision, PreStateSnapshotHash, VerifiedDeltaDigest)`;<br>3. Immediately prior to dispatch, re-verify that the live target state still matches `PreStateSnapshotHash` (preventing TOCTOU drift; mismatch aborts with `APPROVAL_STALE`) |

---

## 4. Architectural Reconstruction: The Five-Kernel Truth-Docked Architecture

Replacing the four-object by five-element administrative registry model, the Circle platform is architected around five tightly coupled kernels:

1. **Kernel 1: Epistemic & Computable Truth Substrate ($\mathcal{K}$, reconstructing `B`)** — Combines the Content-Addressed Raw Artifact Store with product-line **Deterministic Truth Projectors ($\Pi_{\text{ast}}, \Pi_{\text{git}}, \Pi_{\text{cmdtree}}, \Pi_{\text{ledger}}$)** and the five-stratum **Version-Pinned Truth Graph ($\mathcal{K}_{\text{is}} \succ \mathcal{K}_{\text{ought}}$)**.
2. **Kernel 2: Guarded Domain Morphism Engine ($\mathcal{M}$, reconstructing `E`)** — Replaces loose `SKILL.md` prompts and the five hardcoded Excel hooks with declarative **`MorphismPack`s**, each encapsulating $\langle \text{Schema}_{\text{IR}}, \text{Emit}, \mathcal{O}_{\text{truth}}, \text{ReversibilitySpec} \rangle$.
3. **Kernel 3: Convergent Synthesis-Valuation Loop ($\mathcal{L}$, bridging `A` and `E`)** — Replaces the open-loop one-shot submission with a closed-loop **Propose $\to$ Compile $\to$ Valuate $\to$ Counterexample Repair** protocol that iterates until all L1/L2 truth operators pass and mints an unforgeable **Verified Capability Pointer (`vref://sha256:...`)**.
4. **Kernel 4: Diff-Bound Governance Ledger ($\mathcal{C}$, reconstructing `C`)** — Classifies operations into Class 0 / 1 / 2 by their computed state diff $\Delta\sigma$ and enforces two-person independent authorization bound to `(InputRevision, PreStateSnapshotHash, VerifiedDeltaDigest)` for all Class 2 irreversible mutations.
5. **Kernel 5: Fenced Side-Effect & Reconcile Kernel ($\mathcal{D}$, reconstructing `D`)** — Accepts only signed `vref://` pointers, enforces monotonic `fencing_token` leases, TOCTOU pre-state verification, `OBSERVE_EXIT` teardown symmetry, `unknown` resource freezing, and out-of-band worker reconciliation.

---

## 5. Architectural Ruling Principles

From the publication of this specification forward, all architectural evolution across `circle`, `circle-hub`, and `circle-packs` is governed by four binding rulings:

1. **Never degrade deterministic system truths into probabilistic RAG or small-model scoring (`Jev`)**: Any property computable from source ASTs, Git commit DAGs, command trees, or system schemas must be projected deterministically via $\Pi$ into $\mathcal{K}_{\text{is}}^{\text{code}}$ and evaluated by boolean truth operators.
2. **Never route exact numbers, topologies, source slices, hashes, or raw transcripts through the LLM output token stream**: All ground-truth bindings must traverse the intermediate layer via `OpaqueRef / byteSlots` zero-transcription pointers.
3. **Never split multi-round "hypothesis–valuation–repair" tasks into blind client scripts vs. a dead server FSM**: All iterative domain compilation and diagnosis must run through the Kernel 3 ($\mathcal{L}$) counterexample loop before minting a `vref://` capability pointer for Kernel 5 ($\mathcal{D}$).
4. **Never govern side-effects by a static "registration vs. runtime" dogma or a coarse resource boolean**: Every external action is governed strictly by its computed state diff $\Delta\sigma$ and Reversibility Class (Class 0 / Class 1 / Class 2).

---

## Copyright and License Notice

This specification—including the *Triadic Generation–Transformation–Truth Model*, the *Generalized Orthogonal Entropy Decomposition and Zero-Transcription Channel Theorem*, the *Algebra of Repeatable Ground-Truth Valuation and Three Anti-Vacuity Axioms*, the *Five-Stratum Epistemic Authority Partial Order and Deterministic Truth Projection*, the *Reversibility Algebra and State-Diff Governance Law*, and the *Five-Kernel Truth-Docked Architecture*—is an original theoretical and architectural work authored by **qingshanfeihu** (Copyright (c) 2026 qingshanfeihu).

It is licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Anyone who quotes, reuses, adapts, or builds upon the theoretical models, architectural standards, axiom systems, or diagrams in this document—in academic papers, technical documentation, product designs, presentations, or derivative systems—**must fulfill the following attribution requirements**:

1. **Clear Attribution**: Explicitly credit **qingshanfeihu** and **Circle Hub / Circle Platform** as the original authors;
2. **Link to Original Source**: Provide a permanent link to the canonical specification at <https://github.com/circle-platforms/circle-hub/blob/main/docs/design/en/truth-docked-architecture.md> (and its authoritative Chinese original at <https://github.com/circle-platforms/circle-hub/blob/main/docs/design/truth-docked-architecture.md>) alongside the [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/);
3. **Indication of Changes**: Clearly state any modifications, abridgments, or domain adaptations made.

Standard attribution format:

> Based on *Truth-Docked Architecture: A Critical Refutation of Prior Platform Designs and the Theoretical Reconstruction of Enterprise Agents* by qingshanfeihu (Circle Hub Design Specification), <https://github.com/circle-platforms/circle-hub/blob/main/docs/design/truth-docked-architecture.md>, licensed under CC BY 4.0.

See the [design specification index](README.md#license) and the repository [NOTICE](../../../NOTICE).
