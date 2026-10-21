# Object standard: the five-element checklist

> **Rewritten 2026-10-21**: the previous version treated the five elements (records, assets, approval policy, evidence, extension points) as storage partitions of each of the four objects. That is superseded. By the decision on the generic model's pending item 3, the five elements are a design checklist and a record-page layout, not storage partitions. The previous partition table, data flow and adaptation sheet are in [this page at ca66002](https://github.com/circle-platforms/circle-hub/blob/ca66002fb6bfc3220547d0fdd895bfae83345943/docs/design/en/object-standard.md). This page translates the [Chinese original](../object-standard.md); where they differ, the Chinese text is authoritative.

## 1. The four objects are the four homes

The four objects are the four homes of element C01 of the generic model. Content is placed by its nature, and the task pack it ships in does not change its home:

| Home | What it holds | How it changes |
|---|---|---|
| Knowledge | What describes the world at one version: the knowledge tree, knowledge entries, catalogs, fact tables | Re-checked against its sources |
| Policy | What decides what may happen: decision tables, policy tables | Only by deciding again, with samples |
| Method | How to do and how to judge: rules, checks, procedures, a pack's deterministic functions | Run in a sandbox, version-locked, effective with a new pack version |
| Resource | How to connect to a system: integration specifications, system-type profiles, deployment instances, executors | Configured by an administrator; premises default to false |

Ownership is a separate classification (C02), judged per subcomponent with the contract and the implementation classified apart: generic content goes into the Hub core; content with a product dialect goes into a product pack; content with a system dialect and no product semantics goes into a system pack, which an administrator instantiates as a resource; content that serves one workflow goes into a workflow pack. "Used by several workflows" does not make something generic.

## 2. Storage has one shape

The five elements correspond to no table, directory or id prefix. Following the [Hub r4 architecture](../../hub-r4-architecture.md), the Hub stores:

- append-only records: one record table (id, kind, schema, digest, provenance, created_at, body) plus a small index table; the record kinds are `RECORD_KINDS` in the contracts;
- content-addressed object bytes;
- a little mutable state: users, token hashes, the current-root pointers (compare-and-swap) and vault entries.

Everything else is derived from the records. A record's digest is the SHA-256 of the RFC 8785 canonical JSON of `{kind, schema, provenance, created_at, body}`.

## 3. The five elements: checklist and record-page layout

### As a design checklist

When you design a component, a task pack or a system integration, answer every row; a row you cannot answer is a gap.

| Element | Question to answer | Model elements |
|---|---|---|
| Records | Which records does it leave? Is everything that "says something" written as a claim, with grounds, a producer and validity conditions? | B01–B08 |
| Assets | Is every rule, catalog and pack file it uses content-addressed, versioned and locked when the run starts? | B02, T01, W03–W05, C04–C07, D01, D07, K01, K02 |
| Approval policy (now only authorization records) | Who authorizes it, and when? Only two kinds of decision exist: a pack's owner publishes it (it must pass the publish check), and an administrator assigns and configures. There is no approval flow; an authorization is not evidence, and a passed check is not an authorization | B04, T02, R01 |
| Evidence | Which references are the grounds of the result? Where are the Hub's own action and effect records? Where are the rule's own positive and negative samples? | B01, B03, B05, B06, T01, C05 |
| Extension points | Where does it plug in: ownership class, capability declaration, pack function, system-type profile and product-dialect profile, executor registration? Does a new product or a new system type leave the Hub core untouched? | C02, C08, T01, D01, D07 |

### As a record-page layout

A record on the console (read-only, planned) is laid out in the same five parts:

1. The record itself, in the contracts' display order `DISPLAY_ORDER`: position, statement, nature and basis rank, qualifier, grounds, producer, resolution, validity;
2. Assets: the task pack version, rule@version, catalogs and knowledge root digest it rests on;
3. Authorization: the related publish, assignment, configuration or share records, with who decided and when;
4. Evidence: the source fragments and Hub records the grounds point at, the Hub's action records, and the rule's samples;
5. Extension points: the task pack it comes from and its ownership class.

Anything absent or forbidden shows only “对你不可用” (not available to you) and an empty result of the same shape.

## 4. B's rules for originals and Evidence

> **Superseded** (2026-10-21): this section's rules for originals, evidence and indexing belonged to the retired server. Now a source artifact is content-addressed and stored verbatim with its provenance, and a matching hash proves only that it is that very file (B02); a reference is the only form of a claim's grounds (B03); an upload is scanned for credentials and a submission goes through boundary validation (T03); every exact value a model writes is resolved to a reference at the boundary, and quotations are checked verbatim against the source (T04). See the [generic model](generic-model.md).

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
