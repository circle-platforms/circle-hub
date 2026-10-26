import { writeCategorySamples } from './category-samples.ts';
import { classificationSubject } from '../functions/classification-subject.ts';
import { coverageOutcomes } from '../functions/coverage-check.ts';
// The pack's examples (examples/, T01 F[11]) and how they are made (not part of the pack): the synthetic document without its
// Stress cases, as an upload, with the item the projection gives it and the outcome of the coverage check. The tests compare
// the committed files with what this module computes; `node packs/workflow/template-gap/testing/examples.ts` writes them and
// signs pack.json again.
import { writeFile } from 'node:fs/promises';
import { runCheck, type CheckOutcome } from '../../../../hub/rules/api.ts';
import { PACK_DIR, signManifest } from '../api.ts';
import { commandOutcomes } from '../functions/command-check.ts';
import { commandSubject } from '../functions/command-subject.ts';
import { projectDocuments } from '../functions/project.ts';
import { isFailure } from '../functions/common.ts';
import { LOCK } from './index.ts';
import { writeCommandSamples } from './command-samples.ts';
import { coverageSubject } from '../functions/subject.ts';
import type { DocumentItem } from '../functions/types.ts';
import { baseDocument, render, renamed, withoutCategory } from './mindmap.ts';
import { CONTEXT, bind, project, sha256, table } from './support.ts';

export const EXAMPLE_INPUT = 'examples/synthetic-gap.km.json';
export const EXAMPLE_RESULT = 'examples/synthetic-gap.result.json';

export interface ExampleResult {
  note: string;
  input: string;
  sha256: string;
  item: DocumentItem;
  outcome: CheckOutcome;
  command_outcomes: CheckOutcome[];
}

/** The example document as uploaded bytes: compact JSON like an export of the mind-map tool. */
export function exampleBytes(): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(render(renamed(withoutCategory(baseDocument('r0example001'), 'stress'), 'r0example001', '小部件探测测试用例（示例）')))}\n`);
}

export async function exampleResult(bytes: Uint8Array = exampleBytes()): Promise<ExampleResult> {
  const sha = sha256(bytes);
  const projected = projectDocuments({ inputs: [bind(bytes)], parameters: {}, context: LOCK });
  if (isFailure(projected)) throw new Error(projected.error.message);
  const [item] = projected.items;
  const location = `src:${sha}/${item.location.parser}/${item.location.selector}`;
  const subject = classificationSubject({ applies:'item', item:{id:item.id,label:item.label,location,fields:item.fields},slots:{coverage:[]},evidence:[],context:{...LOCK,groups:projected.groups} });
  const [outcome] = coverageOutcomes(subject);
  return {
    note: '合成示例：一份没有压力测试用例的脑图（内容是编的），作为上传文件开始运行时 Hub 给出的条目和覆盖检查的结果；条目编号按上传文件的 SHA-256 前 12 位',
    input: EXAMPLE_INPUT,
    sha256: sha,
    item,
    outcome,
    command_outcomes: commandOutcomes(commandSubject({ item: { ...item, location }, context: { ...LOCK, groups: projected.groups } })),
  };
}

if (import.meta.main) {
  const bytes = exampleBytes();
  await writeFile(`${PACK_DIR}${EXAMPLE_INPUT}`, bytes);
  await writeFile(`${PACK_DIR}${EXAMPLE_RESULT}`, `${JSON.stringify(await exampleResult(bytes), null, 2)}\n`);
  await writeCommandSamples(PACK_DIR);
  await writeCategorySamples(PACK_DIR);
  const manifest = await signManifest();
  console.log(`wrote ${EXAMPLE_INPUT} and ${EXAMPLE_RESULT}; pack.json lists ${manifest.files.length} files`);
}
