import assert from 'node:assert/strict';
import {test} from 'node:test';
import {markdownParser} from '../../../../hub/refs/api.ts';
import {planBuilds} from './sync.ts';
import * as specs from './specifications.ts';

test('specs preserve chapter text and leave command identity and prose applicability undeclared without a locked tree',()=>{
 const source='# Synthetic section\n\n需要 Permit-A 许可。\n\n## Child\n\n执行 `demo pool add`。';
 const parsed=markdownParser.parse(Buffer.from(source));
 const input={slots:{},lists:{documents:[{external:'manual:file:spec/FAMX-10_7.md',parser:'markdown@1',model:parsed.model,sha256:'a'.repeat(64)}]},params:{licenses:['Permit-A']}};
 const first=specs.specifications(input);
 assert.ok(first.entries.length>0);assert.ok(first.entries.every(e=>e.path?.startsWith('/spec/')));
 assert.equal(first.entries.find(e=>e.statement==='执行 `demo pool add`。')?.data.command_literals, undefined);
 assert.ok(first.warnings.some(warning=>warning.includes('缺锁定构建命令树') && warning.includes('下一步')));
 assert.ok(first.entries.every(e=>JSON.stringify(e.data.document_lines).includes('10.7')));
 assert.ok(first.entries.every(e=>!JSON.stringify(e.applicability).includes('build')));
 const child=first.entries.find(e=>e.statement==='执行 `demo pool add`。');
 assert.ok(child);assert.equal(child.applicability,null);
 assert.equal((child.data.applicability_state as {declaration_status:string}).declaration_status,'undeclared');
 assert.equal((child.data.applicability_state as {judgment_status:string}).judgment_status,'unjudged');
 assert.ok(first.entries.some(e=>e.statement==='需要 Permit-A 许可。'));
 assert.deepEqual(specs.specifications(input),first);
});
test('the plan scopes only the declared product names and discloses unrelated documents',()=>{
 const read={'manual:spec-list:configured':{ok:true,parser:'json@1',model:{complete:true,files:[{name:'FAMX-10_7.md',path:'spec/FAMX-10_7.md'},{name:'neutral.md',title:'FAMY synthetic design',path:'spec/neutral.md'},{name:'Other.md',path:'spec/Other.md'}]}}};
 const out=planBuilds({round:1,read,options:{spec_index:true}} as any);
 assert.deepEqual(out.scope?.spec_documents,['manual:file:spec/FAMX-10_7.md','manual:file:spec/neutral.md']);
 assert.match(out.note??'',/不属于这条产品线.*1/);
});
test('an incomplete spec listing never replaces an existing product-wide root with partial sources',()=>{
 const out=planBuilds({round:1,read:{'manual:spec-list:configured':{ok:true,parser:'json@1',model:{complete:false,unread:['spec'],files:[]}}},options:{spec_index:true}} as any);
 assert.equal(out.scope,undefined);assert.match(out.note??'',/规格.*下一步/);
});
test('spec file references encode names before delimiters can become revision syntax',()=>{
 const file={name:'FAMX 10_7@draft.md',path:'spec/FAMX 10_7@draft.md'};
 const planned=planBuilds({round:1,read:{'manual:spec-list:configured':{ok:true,parser:'json@1',model:{complete:true,files:[file]}}},options:{spec_index:true}} as any);
 assert.deepEqual(planned.scope?.spec_documents,['manual:file:spec/FAMX%2010_7%40draft.md']);
 const model=markdownParser.parse(Buffer.from('# Synthetic\n\n需要 Permit-A 许可。')).model;
 const produced=specs.specifications({slots:{},lists:{documents:[{external:(planned.scope!.spec_documents as string[])[0],parser:'markdown@1',model,sha256:'a'.repeat(64)}]},params:{licenses:['Permit-A']}});
 assert.ok(produced.entries.every(entry=>JSON.stringify(entry.data.document_lines).includes('10.7')));
});
