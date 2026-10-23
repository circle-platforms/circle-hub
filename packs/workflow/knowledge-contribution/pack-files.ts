// Derive the output vocabulary from the model; never maintain a second enumeration in this pack.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_OUTPUT_KIND, RELATION_KIND, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { manifestProblems, signManifest } from '../case-review/packaging.ts';
const directory = fileURLToPath(new URL('./', import.meta.url));
export function slots() {
  const quote = { type: 'object', additionalProperties: false, required: ['reference', 'quote'],
    properties: { reference: { type: 'string' }, quote: { type: 'string' } } };
  return {
    schema: 'slots@1',
    item: { contribution: {
      min: 1, max: 1,
      codes: DOCUMENT_OUTPUT_KIND.map(code => ({ code, label: labelOf('document_output_kind', code) })),
      data: { type: 'object', additionalProperties: false, required: ['root', 'path', 'source'], properties: {
        root: { type: 'string' }, path: { type: 'string' }, source: quote,
        relation: { type: 'object', additionalProperties: false, required: ['kind', 'other'],
          properties: { kind: { enum: RELATION_KIND }, other: quote } },
      } },
    } },
    run: {},
  };
}
if(import.meta.main){
  const path=new URL('./slots.schema.json',import.meta.url);const text=JSON.stringify(slots(),null,2)+'\n';
  if(process.argv.includes('--check')){
    const problems=await manifestProblems(directory);
    if(await readFile(path,'utf8')!==text)problems.push('slots.schema.json differs from generated vocabulary');
    if(problems.length)throw new Error(problems.join('\n'));
    console.log('knowledge-contribution: generated slots and manifest match');
  }else{await writeFile(path,text);await signManifest(directory);}
}
