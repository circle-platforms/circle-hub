---
permalink: /design/en/truth-docked-architecture/
nav_order: 9
---

# Truth-Docked Architecture: Foundations, Conditional Claims, and a Product Research Framework

**Status: research proposal and mathematical audit, revised 2026-10-19. This document does not describe implemented capabilities or replace current object, permission, approval, execution, or client contracts.**

> **Note of 2026-10-21**: the current design that section 2 refers to (the object standard's five elements, execution flows, the approval specification, the five fixed Hooks) was retired with the old server, so the sentence “B/C/D/E, current enforcement, and approved rules continue under their current specifications” no longer holds. The design authority is now the generic model ([contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json), summarised in the [generic model](generic-model.md)); this document's status as a research proposal is unchanged.

This revision replaces the assertions in [the ea926d4 draft](https://github.com/circle-platforms/circle-hub/blob/ea926d47b5eb641a4b79dc9207a190e61ac60fe0/docs/design/truth-docked-architecture.md). That draft did not establish proofs for its overall guarantees of “four theorems,” supreme architectural authority, absolute truth, or perfect finite-round convergence. This revision withdraws those guarantees and their automatic supersession of existing designs. Git retains the original.

The research directions of constrained generation, exact references, deterministic transformation, structured checks, and controlled execution remain. Literature, conditional claims, unproved assumptions, and candidate implementation choices are separated below. The small proofs are conditional arguments checked by hand, not by a proof assistant; they do not prove the reliability of the Circle platform. The [Chinese original](../truth-docked-architecture.md) is authoritative if the translations differ.

## 1. Research problem and reasoning discipline

The subject is an agent completing engineering tasks in a changing system that it can observe only partially. A task may combine:

- **World-state goals:** change a program, restore a service, alter a configuration, or produce an artifact meeting a contract.
- **Epistemic goals:** establish version impact, eliminate hypotheses, diagnose a cause, or check a property.
- **Process constraints:** authority, resource scope, safety invariants, time, and computation budget.
- **Completion conditions:** which outcomes must occur and what scope of evidence each judgment needs.

Restoring a service and identifying its cause are different completion conditions. Representing them separately is a modeling choice informed by planning with epistemic and ontic goals. It does not prove that every engineering task reduces to a solvable problem.

Three distinct lines of work are required:

| Layer | Question | What cannot substitute for it |
|---|---|---|
| Internal theoretical validity | Are definitions consistent, and do conclusions follow from stated premises? | Passing tests, a bibliography, or an architecture diagram |
| Model applicability | Does the real system satisfy coverage, observation, and interference assumptions? | A proof inside the model or a source hash |
| Implementation conformance | Do code, compilers, and execution protocols implement the specified semantics? | Type correctness or a successful API response |

Every guarantee needs definitions, quantifiers, premises, a proof or counterexample, scope, and implementation obligations. Definitions, established literature results, conditional claims in this document, engineering policies, architectural candidates, and unproved assumptions must remain distinguishable.

## 2. Relationship to the current design

This research does not depend on mischaracterizing the current design:

- The [object standard](object-standard.md) and runtime-object reference allocate authority and responsibilities; professional algorithms and domain validation already have a methods-layer owner. Ownership boundaries and computational loops can coexist.
- [Execution flows](execution-flow-packs.md) already have persistent state, observations, actions, and step identities. A pure transition function not directly calling a model does not imply that the system cannot call models or form loops.
- The Knowledge V1 reference separates exact parsing from semantic judgment. semantic=not-asserted bounds a conclusion; it does not deny completed structural checks.
- The [approval specification](approvals-and-enforcement.md) already has execution-submission approval bound to concrete inputs and consumable by the corresponding operation. More precise impact policy is a research direction, not a consequence of an absence of execution approval.
- The five fixed Hooks and their domain subjects are current contracts. Generalizing them requires separate contract design, compatibility work, and acceptance; this document does not remove them.

B/C/D/E, current enforcement, and approved rules continue under their current specifications. A replacement requires an independently agreed scope before code and contracts change. Current behavior and implementation progress remain in the corresponding specifications and [phase records](../../index.md#历史记录).

## 3. Relevant theory and its limits

| Theory | Useful contribution | Guarantee not inherited automatically |
|---|---|---|
| Epistemic planning and partial observability [R1][R2] | Distinguish world-state and knowledge goals; update knowledge from actions and observations; conditional plans | R1 uses finite states, deterministic actions, and specified sensing semantics; R2 depends on its transition, observation, and decision models |
| Abstract interpretation and semantic preservation [R3][R11] | State which properties a representation preserves; relate models and transformations to concrete behavior | Connecting ASTs, command trees, configurations, and logs does not establish equivalence; determinism alone does not prove correctness |
| Program logic and syntax-guided synthesis [R4][R5] | Preconditions, postconditions, composition obligations, candidate grammars, and semantic specifications | Schema validity is not semantic correctness; partial correctness is not termination; a finite grammar description need not denote a finite candidate set |
| Counterexample-guided abstraction refinement [R6] | Distinguish concrete counterexamples from abstraction artifacts and refine models using evidence | An arbitrary field failure does not establish a model defect or authorize weaker acceptance criteria |
| Proof-carrying code [R7] | Separate candidate production from independent checking and reduce the trusted checking core | A hash, signature, or test report is not a formal proof or execution authority |
| Provenance and incremental computation [R8][R9] | Track inputs, activities, responsibility, derivations, and dependencies; determine recomputation | Provenance does not prove truth; live observations cannot be reused forever under file-cache rules |
| Temporal specification and causal reasoning [R10][R12] | Study execution-trace properties and distinguish observation, intervention, and causal questions | Restoring a final state does not erase intermediate losses; correlated observations do not identify a cause automatically |

These theories use different state, probability, time, and observation assumptions. Their composition needs semantic relations at the interfaces and new arguments for the required properties. Published guarantees cannot simply be multiplied or added.

## 4. A minimal set-based knowledge-update model

This section fixes one model revision, interpretation of predicates, and task scope. It supplies a formal object for conditional claims; it does not assert that a real engineering system satisfies the assumptions.

Definitions:

- S: concrete system states in scope, including all information required by the properties under discussion.
- A: actions.
- s_t: the actual state at observation boundary t.
- B_t ⊆ S: states not yet excluded; this is not a probability distribution.
- T(s,a) ⊆ S: real possible successor states between action a in s and the next observation boundary, including allowed environmental interference during that interval.
- T_hat(s,a) ⊆ S: the transition approximation used by the implementation.
- C_a(o) ⊆ S: states compatible with observation o following action a. Target, version, time, read scope, and parsing belong to the observation semantics.

Define:

    Post_hat(B,a) = ⋃ { T_hat(s,a) : s ∈ B }
    B_(t+1) = Post_hat(B_t,a_t) ∩ C_(a_t)(o_(t+1))

### P1: Preservation of actual-state coverage (conditional claim)

Premises:

- A1 Initial coverage: s_0 ∈ B_0.
- A2 Transition coverage: T(s,a) ⊆ T_hat(s,a) for every in-scope s,a.
- A3 Conservative observation: every actual observation o_(t+1) satisfies s_(t+1) ∈ C_(a_t)(o_(t+1)).
- A4 Consistent trajectory and time: s_(t+1) ∈ T(s_t,a_t), and the intersected observation describes that same boundary. Staggered samples, external changes, and delays must be represented in T, the state, or the observation model.

Conclusion:

    For every defined step t, s_t ∈ B_t

Proof: A1 gives the base case t=0. Assume s_t ∈ B_t. By A4, s_(t+1) ∈ T(s_t,a_t); A2 then puts it in T_hat(s_t,a_t), hence in Post_hat(B_t,a_t). A3 also puts it in C_(a_t)(o_(t+1)). It therefore belongs to their intersection B_(t+1). Induction proves the claim.

This is a hand-written argument following standard conservative state-estimation reasoning, not a claim of a new mathematical discovery. P1 does not establish A1–A4 for any device, parser, dataset, or execution protocol. It does not establish plan safety, optimality, or eventual success.

### C1: Scoped property judgments (conditional corollary of P1)

Let P have a fixed interpretation over S. If B_t is nonempty and every state in B_t satisfies P, then P(s_t) holds. Proof: P1 makes s_t a member of B_t; instantiate the universal premise at that member.

The judgment interface must distinguish:

- Nonempty B_t with all states satisfying P: support P under this section's premises.
- Nonempty B_t with all states satisfying not P: refute P under those premises.
- B_t containing states on both sides: unresolved.
- Empty B_t: assumptions and observations are incompatible; vacuous universal statements must not certify either business judgment.

These are meanings in the research model, not changes to current API status enums. Historical observations support their corresponding boundary only. Moving to dispatch time needs an additional transition argument or an atomic condition.

### Counterexamples when premises fail

| Missing premise | Counterexample | Lost guarantee |
|---|---|---|
| Initial coverage | The target runs a different build while the initial set contains only the expected build | A consistent derivation can describe the wrong target |
| Transition coverage | Reboot, concurrent administration, or remote acceptance with a lost reply was omitted | A real successor can be excluded |
| Conservative observation | Timeout is interpreted as “not executed” although execution occurred and its reply was lost | A repeated dispatch can duplicate side effects |
| Consistent observation time | Two fields sampled at different times are treated as an atomic snapshot | Individually genuine observations can produce an invalid intersection |
| Nonempty judgment | Conflicting evidence empties B_t, after which “all candidates satisfy P” authorizes progress | Both P and not P can be inferred vacuously |

A lost reply generally requires preserving both executed and unexecuted possibilities unless additional protocol facts exclude one. A confidence field does not repair invalid observation semantics.

## 5. Finite search and termination: a separate claim

### P2: A bound on finite exhaustive candidate search (conditional claim)

Fix the task specification and its interpretation. Let H be finite, with |H|=N. Assume:

1. Each round checks a previously unchecked candidate; selection and checking terminate.
2. The checker gives correct and complete pass/fail judgments for that fixed specification.
3. Search continues until a candidate passes or H is exhausted, without changing the specification, candidate set, or checker semantics.

Within at most N candidate checks, search finds a satisfying candidate or establishes that none exists in H.

Proof: Each failing check removes one previously unchecked candidate, strictly decreasing the remaining count. A satisfying candidate, if encountered, is accepted by the correct checker. If all N candidates fail, exhaustiveness establishes that H contains no solution.

The bound counts candidate checks, not uniform wall-clock time or physical outcomes. It does not establish that H covers every solution the user permits. If checking can return unknown or consists only of finite tests, this argument cannot establish that H has no solution.

Counterexamples and limits:

- Even with one correct and one incorrect candidate, a generator that repeats the incorrect one need not converge.
- A finite alphabet or grammar can generate infinitely many programs; types and JSON Schema do not automatically make H finite.
- Changes to the specification, model, or method version invalidate automatic use of the previous bound.
- Stopping at budget K bounds work; exhausting K establishes neither existence of a solution nor discovery of a correct one.
- LLM candidate ordering may improve efficiency but does not establish non-repetition, completeness, or termination.

## 6. Core properties still requiring definitions and proofs

The following are obligations, not established theorems of this document:

| Property | Definitions and premises still needed | Implementation obligation |
|---|---|---|
| Semantic preservation by transformation | Source and target languages, observation scope, allowed behaviors, and transformation relation | Compiler proof or explicitly scoped per-artifact validation; pinned versions and inputs |
| Correct method composition | Preconditions, postconditions, resource scope, interference, and sequential/concurrent semantics | Check adjacent contracts and shared state; establish termination separately |
| Exact-reference preservation | Resolution, permission, byte identity, encoding, and assembly semantics | Opaque references and byte checks; still check that the correct object was referenced |
| Warranted judgment | Predicate meaning, source/model scope, and checker properties | Retain dependencies, open assumptions, counterexamples, and applicable time |
| Identifiable causes | Candidate models, permitted observations/interventions, and distinguishability | Represent competing explanations and select experiments; retain ambiguity when they cannot be distinguished |
| Authorized, nonduplicated effects | Authorization consumption, target protocol, concurrency, faults, and recovery | Separate dispatch, acceptance, result, and reconciliation; check target conditions and identity |
| Progress and recovery | Safety invariants, stopping conditions, fairness, and environmental availability | Budget, waiting, cancellation, recovery, and unresolved paths |

Zero transcription removes the failure channel in which a model regenerates original bytes. Wrong sources, misbound references, compiler defects, and stale state still need separate analysis. Hashes and signatures provide their specified identity/integrity properties, not business correctness.

Reversibility is one policy input. Restoring configuration does not establish restoration of interrupted connections, external notifications, or business losses. State delta, environment criticality, authorization scope, observability, and recovery conditions need separate models.

Execution safety concerns complete traces. If interference is possible between a check and a write, a pre-dispatch hash check alone is not an atomic condition; a target-side protocol or separately justified exclusion boundary is needed.

## 7. Candidate product framework derived from the research

The following decomposition is a design choice with no uniqueness or end-to-end reliability proof.

### Two compilation paths

- **Domain compilation:** versioned sources and interfaces → structural extraction and model construction → domain types, predicates, transformations, actions, and observations. Semantic inferences retain hypothesis status and their grounds; extraction does not automatically establish real behavior.
- **Task compilation:** user goals → explicit task specification → verification obligations → a conditional action plan. Each obligation states its predicate, scope, acceptable evidence, and unresolved handling.

Execution evidence feeds both knowledge and task processing. Revising a candidate and revising the domain model are different activities. Changes to a model, specification, or checker create a revision with independent review and regression grounds.

### Logical modules and responsibilities

| Candidate module | Responsibility | Main objects |
|---|---|---|
| Domain models and methods | Define types, behavior, transformations, observations, and checking semantics | Model revisions, method contracts, compilers, checkers |
| Knowledge and evidence | Preserve originals, observations, derivations, and scope | Source revisions, evidence, claims, dependency graph |
| Task compilation | Turn goals into obligations and candidate methods | Task specifications, obligations, candidate plans |
| Planning and experiment selection | Choose investigation, construction, checking, or action within budget and authority | Hypotheses, experiments, branches, budgets |
| Checking and authorization | Separately establish condition satisfaction and permission | Verification records, policy decisions, single-use permits |
| Durable execution | Implement dispatch, concurrency, disconnection, and reconciliation | Operation intents, leases, receipts, reconciliation |

A domain language needs syntax, types, and execution/interpretation rules. TypeScript types and runtime schemas perform their stated structural checks; they do not replace semantic or protocol guarantees. A model may propose candidates and investigative steps. Claiming “verified” or possessing a hash cannot bypass authoritative checking and authorization.

Product lines may use different domain languages with common checking, evidence, and execution contracts. This research requires neither a universal IR nor six separately deployed services. Migration requires a separate design grounded in current code and consumer boundaries.

### Product views

A task view may organize goals, established facts, competing hypotheses, open obligations, candidate changes, authorization, and observed results. It should distinguish delivery, checking a scoped property, and changing an external state. These are candidate product views, not features delivered by this document change.

## 8. Research order: audit the mathematics first

1. Freeze minimal definitions and assumptions; state quantifiers, semantics, and scope for each property.
2. Write conditional proofs and use counterexamples to examine the necessity and sufficiency of premises.
3. Mechanize suitable proofs; model-check finite protocols. Report the proof-checker trust base, model boundary, and uncovered cases separately.
4. Establish correspondence obligations from real sources, parsers, transition approximations, and observers to the formal model.
5. Use existing engineering artifacts, execution records, and authorized trace data to seek counterexamples and check applicability/conformance. More samples do not substitute for proof.
6. Decide core interfaces, domain-package contracts, and migration scope after those boundaries are explicit.

Existing engineering and trace material is available for later research; derivation and assumption audit take priority over collecting new samples. Public documents contain public definitions, sanitized synthetic counterexamples, and scoped conclusions only. Access locations, credentials, raw business contents, and private traces do not enter the public repository.

This document provides hand-written conditional arguments for P1, C1, and P2 and several logical counterexamples. It provides no machine-checked proof, real-data conclusion, target-side guarantee, or platform-wide correctness proof. Reference SHA/Git-tree checks and their tests establish archive integrity, not this document's mathematics or architecture.

## 9. Primary research and standards

- **R1** Baier, Mombourquette, McIlraith, 2014, [Diagnostic Problem Solving via Planning with Ontic and Epistemic Goals](https://www.cs.toronto.edu/~sheila/publications/bai-mom-mci-kr14.pdf).
- **R2** Kaelbling, Littman, Cassandra, 1998, [Planning and Acting in Partially Observable Stochastic Domains](https://cs.brown.edu/courses/csci2951-k/papers/kaelbling98.pdf).
- **R3** Cousot and Cousot, 1977, [Abstract Interpretation](https://cs.nyu.edu/~pcousot/COUSOTpapers/POPL77.shtml).
- **R4** Hoare, 1969, [An Axiomatic Basis for Computer Programming](https://www.cs.cmu.edu/~crary/819-f09/Hoare69.pdf).
- **R5** Alur et al., 2013, [Syntax-Guided Synthesis](https://www.cis.upenn.edu/~alur/SyGuS13.pdf).
- **R6** Clarke et al., 2000, [Counterexample-Guided Abstraction Refinement](https://www.cs.cmu.edu/~emc/papers/Conference%20Papers/Counterexample-guided%20Abstraction%20Refinement.pdf).
- **R7** Necula, [Proof-Carrying Code overview and original papers](https://people.eecs.berkeley.edu/~necula/pcc.html).
- **R8** W3C, 2013, [PROV-DM](https://www.w3.org/TR/prov-dm/).
- **R9** Mokhov, Mitchell, Peyton Jones, 2018, [Build Systems à la Carte](https://www.microsoft.com/en-us/research/publication/build-systems-la-carte/).
- **R10** Lamport, [Specifying Systems](https://lamport.azurewebsites.net/tla/book.html).
- **R11** CompCert, [Semantic preservation, verification scope, and compiler structure](https://compcert.org/man/manual001.html).
- **R12** Pearl, [The Three Layer Causal Hierarchy](https://web.cs.ucla.edu/~kaoru/3-layer-causal-hierarchy.pdf).

These references identify relevant theory and its original scope; they do not endorse this proposal's composition or implementation. This proposal does not claim those studies, axioms, or general methods as Circle inventions.

## License

Copyright (c) 2026 qingshanfeihu. This document's text and diagrams are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribute Circle Hub and qingshanfeihu, link to the source, and identify changes as the license requires. Cited research retains its authorship and licenses. See the [design index](README.md#license) and [NOTICE](https://github.com/circle-platforms/circle-hub/blob/main/NOTICE).
