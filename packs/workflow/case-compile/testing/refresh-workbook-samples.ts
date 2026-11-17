// The generator's name is written into a workbook, so the workbook samples change with every version of the pack. This
// regenerates only those four samples from their own inputs: node packs/workflow/case-compile/testing/refresh-workbook-samples.ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseManifest } from '../functions/manifest.ts';
import { parseProfile } from '../functions/profile.ts';
import { parseRuntimeContract } from '../functions/runtime-contract.ts';
import { generateWorkbook, GENERATOR } from '../functions/generate.ts';
import { coreModel } from './workbook-model.ts';

const path = (polarity: string, check: string) => new URL(`../samples/${polarity}/typed-${check}.json`, import.meta.url);
const read = (polarity: string, check: string) => JSON.parse(readFileSync(path(polarity, check), 'utf8'));
const base = read('positive', 'workbook_verified').subject;
const contract = parseRuntimeContract(base.contract), manifest = parseManifest(base.manifest);
if (!contract.ok || !manifest.ok) throw new Error('invalid sample inputs');
const profile = parseProfile(base.profile, contract.contract, manifest.beds);
if (!profile.ok) throw new Error('invalid sample profile');
const generation = { ...base.generation, generator: GENERATOR };
const bytes = generateWorkbook({ slots: base.data, fields: base.fields, contract: contract.contract, profile: profile.profile, ...generation });
const workbook = { model: coreModel(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
for (const check of ['workbook_verified', 'dispatch_policy']) for (const polarity of ['positive', 'negative']) {
  const sample = read(polarity, check);
  sample.subject.generation = generation;
  sample.subject.workbook = polarity === 'positive' ? workbook : { ...workbook, sha256: 'f'.repeat(64) };
  writeFileSync(path(polarity, check), `${JSON.stringify(sample, null, 2)}\n`);
}
console.log(`four workbook samples refreshed for ${GENERATOR}`);
