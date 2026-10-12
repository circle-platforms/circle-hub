---
name: apv-mindmap-compile
description: Compile an APV test mindmap (the JSON export, cases with an 18-digit autoid) into the execution workbook case.xlsx for one build, using the circle-server tools for the build's command tree, the manuals and ZenTao. Use when asked to compile, 编译 or turn a mindmap into test cases for APV.
---

# APV 脑图用例编译

Turn a test mindmap into the execution workbook for one APV build. The scripts in `scripts/` do every step that has one right answer; you do the two steps that need judgement, **recompose** and **author**, and the scripts check both. Nothing runs on a device here: a written case is "emitted, unverified".

Read `references/contract.md` before writing any JSON: it has the exact shapes.

## 0. What you need

- The mindmap JSON export in the workspace. A `.xmind` file is not this format; ask for the export.
- The version line (for example `10.4`), and a build if the user names one.
- circle-server tools, offered after `/server login` as `srv_*`: `srv_buildsite_versions`, `srv_buildsite_command_heads`, `srv_buildsite_command_param`, `srv_buildsite_command_check`, `srv_docs_search`, `srv_docs_section`, `srv_zentao_bug_search`, `srv_zentao_bug_detail`, `srv_knowledge_claim_submit`. If they are missing, say so and stop: do not write commands from memory.

The batch folder is `out/`; the scripts write every result there, and these are the files a run on the server hands back. On the server there is nobody to ask: the request is in `inputs.json` (`mindmap`, `versionLine`, optionally `build`), and the mindmap file is next to it. A bot's run also carries `trigger` (the schedule time or the connector event that started it); it changes nothing in the steps, and with no `build` named a scheduled run compiles for the latest formal build of that day.

## 1. Prep (script)

```
node <skill>/scripts/prep.mjs <mindmap.json> out
```

It writes `manifest.json`: every case with its autoid, group path, layout and step intents, and never a command. On `ok:false`, tell the user the reason; the whole batch stops (one root only, 18-digit autoids, no duplicates).

## 2. Bind the build

Call `srv_buildsite_versions` for the version line. Use the build the user named; otherwise the latest **formal** build (a `Rel_` build with a release date) on the main platform (`platform` null), unless the user names a platform. A Beta build only when the user asks for it. Skip a build marked `current: false`: the site lists conflicting rebuilds of it. If the bound build has `commandTreeAvailable: false`, stop and say so: there is no command tree to check against.

Every later query passes this build's `buildId` as `build`, because the same build name exists on several platforms. The case files keep the build name, as the tools return it in `build`.

## 3. Recompose (you), then check (script)

Write `out/machine_mindmap.json`: for each case its bucket, its contract triple (intent, verification method, expectation) and its expectations by step, each with an origin.

- **Relocate, never write.** Every contract field and expectation is the whole text of one source atom: the case title, a step, or an expectation (`title`, `step:<n>`, `expectation:<label or n>`). A numbering prefix such as `1.` or `[check1]` may be left off; nothing else may change.
- A spec sentence or a ZenTao bug may also be a source (`spec:<file>:<line>`, `defect:zentao:BUG-<n>:title|description`), only verbatim and only after you read it with the tools.
- A case whose source lacks steps or expectations is `true_gap`: no contract, and what is missing goes into `proposal` as plain sentences. Do not fill the gap yourself.
- Manuals are never a source for the contract.

```
node <skill>/scripts/check-recompose.mjs out
```

Fix every violation it lists and run it again until `ok:true`.

## 4. Author (you)

For each case that is not `true_gap`, write `out/cases/<autoid>.json`, the mechanical case.

- `description.intent_verbatim` and `description.group_path` are copied byte for byte from the contract and the manifest.
- **Every device command comes from the bound build.** Find heads with `srv_buildsite_command_heads`, arguments with `srv_buildsite_command_param`, and the manual with `srv_docs_search` for the version line (`version`, which searches that version's CLI manual) and `srv_docs_section` (the section that starts `**<head>**`). Never write a command from memory, and never "repair" a command the author wrote.
- `srv_buildsite_command_param` lists every signature of a head. When `overloaded` is true there is more than one and `parameters` is empty: pick the signature whose parameters say what the case does, and write the arguments in that signature's order.
- When the version line has no CLI manual, `srv_docs_search` answers `SOURCE_ABSENT`. Go on without the manual and say so in the report: the manual only explains how a value shows on screen; it never decides a command or an expectation.
- Blocks: `CONFIG` (commands to configure), `OBSERVE_ASSERT` (a show command and one or more checks: `found`, `not_found`, `abs_found` with a pattern), `SLEEP` (seconds), `STEP` (a row the blocks cannot express, with a reason in `escape_hatches`).
- Each expectation of the case is asserted **exactly once**, carrying its id `u1:<autoid>:<n>:<index>`, and listed in `expectation_binding` with what backs it (`Author`, `Manual`, `CapabilityXml`, `Spec`, `DefectSpec`).
- Expected values come from the contract's expectations. A manual may explain how a value shows on screen; device output never decides what is expected.
- Clean up what the case configures: add the inverse commands after the checks.
- Then call `srv_buildsite_command_check` once with **all** the case's device commands and copy each result into `command_receipts` as returned (`command`, `build`, `status`, `head`, `violations`, `evidenceId`). A command passes when it matches one whole signature; `violations` then is empty, otherwise it holds the codes of the closest signature (`ARGUMENT_COUNT`, `TYPE_MISMATCH`, `OUT_OF_RANGE`, …). Do not write a receipt yourself.

## 5. Gate (script)

```
node <skill>/scripts/gate.mjs out
```

For each rejected case, fix what the violations name and run it again; at most three rounds per case, then leave it rejected. `command_not_in_tree` means the build does not have the command: the case is an **unsupported feature** for this build. Do not look for another command and do not retry it.

## 6. Emit (script) and report

```
node <skill>/scripts/emit.mjs out --author <user>
```

Report the totals from `compile_report.json`, the path and SHA-256 of `case.xlsx`, and the cases that were not written with their reasons (`unsuccessful_cases.md`). Say plainly that nothing has run on a device.

## 7. What you learned

When the user corrects you, or you find a fact that a later compile would need (a command a build renamed, a field that joins two systems), submit it with `srv_knowledge_claim_submit`, with the evidence ids you read it from. It becomes a candidate that someone reviews; do not rely on it until it is published.
