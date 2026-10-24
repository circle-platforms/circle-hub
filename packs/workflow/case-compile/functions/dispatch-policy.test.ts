import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {generateWorkbook} from './generate.ts';
import {generationFixture} from '../testing/workbook.ts';
import {workbookCheckInput} from '../testing/workbook-model.ts';
const require=createRequire(import.meta.url);
test('the frozen dispatch policy returns only the exact verified generic job parameters',async()=>{
 const {default:check}=await import('./dispatch-policy.ts');const table=require('../policies/dispatch.json');
 const input=workbookCheckInput(generateWorkbook(generationFixture()));
 const outcome=check({...input,table});assert.equal(outcome[0].verdict,'support');
 const parameters=outcome[0].data!.parameters as Record<string,unknown>;
 assert.deepEqual(Object.keys(parameters).sort(),['build','generator','items','manifest_sha256','sha256','target']);
 assert.equal(parameters.sha256,(input.subject.workbook as {sha256:string}).sha256);
 const bad=structuredClone(table);bad.max_items=0;
 assert.equal(check({...input,table:bad})[0].verdict,'refute');
});
