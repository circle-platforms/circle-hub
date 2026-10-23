import { createDefaultRegistry, recognize, parserKey } from '../../../../hub/refs/api.ts';
import { unzipSync } from 'fflate';
import { readWorkbookModel, type WorkbookModel } from '../functions/xlsx-model.ts';
import { zipStore } from '../functions/zip-store.ts';
import { generateWorkbook, GENERATOR } from '../functions/generate.ts';
import { generationFixture } from './workbook.ts';
import { CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, subjectOf } from '../functions/test-support.ts';
import { createHash } from 'node:crypto';
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function coreModel(bytes: Uint8Array): WorkbookModel {
  const parsed = recognize(createDefaultRegistry(), bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  if (!parsed || parserKey(parsed.parser) !== 'xlsx@1') throw new Error('fixture did not parse as xlsx');
  const model = readWorkbookModel(parsed.document.model); if (!model) throw new Error('xlsx model shape drift'); return model;
}
export function changedWorkbook(edit: (parts: Map<string, string>) => void): Uint8Array {
  const original = unzipSync(generateWorkbook(generationFixture())); const parts = new Map(Object.entries(original).map(([name, bytes]) => [name, Buffer.from(bytes).toString('utf8')]));
  edit(parts); return zipStore([...parts].map(([name, text]) => ({ name, bytes: Buffer.from(text, 'utf8') })));
}
export function workbookCheckInput(bytes = generateWorkbook(generationFixture())) {
  const recipe = generationFixture(); const base = subjectOf(recipe.slots).subject;
  return { subject: { ...base, fields: recipe.fields, contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC, manifest_sha256: digest(Buffer.from(JSON.stringify(MANIFEST_DOC))), generation: { plan_run: recipe.plan_run, build: recipe.build, generator: GENERATOR }, workbook: { model: coreModel(bytes), sha256: digest(bytes) } } };
}
