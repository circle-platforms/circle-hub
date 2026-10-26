import type {CommandIdentity,ExpectedQuoteIdentity} from '../../../contracts/generated/shared-interfaces.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {checkDuplicate} from './functions/checks.ts';
import {SYNTHETIC_CATALOG,SYNTHETIC_INDEX_VIEW,makeDuplicateDraft,makeGoodDraft} from './testing/fixtures.ts';
import {nativeStep} from './testing/structure.ts';
function check(draft=makeDuplicateDraft(),view=structuredClone(SYNTHETIC_INDEX_VIEW)){return checkDuplicate({subject:{item:'synthetic',drafts:[draft],indexed_cases:view},catalog:SYNTHETIC_CATALOG})[0];}
test('published duplicate requirement names structure and excludes titles',()=>{
 const requirement=JSON.parse(readFileSync(new URL('./requirements.json',import.meta.url),'utf8')).requirements.find((r:{key:string})=>r.key==='not_duplicate');
 assert.match(requirement.description,/case-structure@2/);assert.match(requirement.description,/标题不参与/);
});
test('different titles with identical declared structures refute',()=>{const draft=makeDuplicateDraft();draft.title='不同的标题';assert.equal(check(draft).verdict,'refute');});
test('identical titles with different parameter values do not duplicate',()=>{
 const view=structuredClone(SYNTHETIC_INDEX_VIEW),draft=makeGoodDraft(),entry=Object.values(view.entries)[0];
 draft.title=entry.data.title as string;
 entry.data.case_structure={schema:'case-structure@2',commands:[nativeStep('widget health interval 30').identity],expected:draft.expected.map(e=>({after:e.after,quote:e.identity}))};
 assert.equal(check(draft,view).verdict,'support');
});
for(const field of ['source_sha256','parser','path','offset','length','after'])test('quote identity includes '+field,()=>{
 const draft=makeDuplicateDraft();const expected=draft.expected[0],identity=expected.identity as ExpectedQuoteIdentity;
 if(field==='after'){draft.steps.push(nativeStep('show health'));expected.after=2;}
 else if(field==='offset'||field==='length')identity.span[field]++;
 else if(field==='source_sha256')identity.source_sha256='e'.repeat(64);
 else if(field==='parser')identity.parser='text@2';else identity.path='l/2';
 assert.equal(check(draft).verdict,'support');
});
test('missing command or quote identity remains unknown even with identical titles',()=>{
 for(const missing of ['command','quote']){const draft=makeDuplicateDraft();if(missing==='command')delete draft.steps[0].identity;else delete draft.expected[0].identity;const out=check(draft);assert.equal(out.verdict,'unknown');assert.match(out.missing!,/下一步/);}
});
test('raw spelling of a typed integer is not part of the parsed parameter key',()=>{
 const draft=makeGoodDraft(),view=structuredClone(SYNTHETIC_INDEX_VIEW);Object.values(view.entries)[0].data.case_structure={schema:'case-structure@2',commands:draft.steps.map(s=>s.identity),expected:draft.expected.map(e=>({after:e.after,quote:e.identity}))};
 (draft.steps[0].identity as CommandIdentity).parameters[0].raw='060';assert.equal(check(draft,view).verdict,'refute');
});
