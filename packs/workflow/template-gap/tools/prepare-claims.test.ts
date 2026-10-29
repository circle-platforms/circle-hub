import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CategoryJudgmentSchema } from '../../../../contracts/generated/shared-interfaces.ts';
import { parseModel } from '../../../skill/mindmap-format/tools/parse-model.ts';
import { locateCandidates } from '../../../skill/mindmap-format/tools/locate-quotes.ts';
import { classify } from '../functions/classification.ts';
import { readTemplate } from '../functions/template.ts';
import TABLE from '../tables/template-v3.json' with {type:'json'};
import { declaredIdentity, prepareClaims } from './prepare-claims.ts';
import { stagePack } from '../api.ts';

const identity={model_id:'synthetic-model',model_family_id:'synthetic-family'};
const node=(id:string,text:string,children:unknown[]=[])=>({data:{id,text,priority:2,...(id==='case'?{resource:['Functional']}:{})},children});
const document=()=>({root:node('root','合成脑图',[node('case','合成用例',[node('step','合成🧪 回显')])])});
const choice={ordinal:1,category_id:'audit_log',statement:'合成类别判断'};

test('one explicit identity assembles exact quoted claims without deciding the category',()=>{
  const raw=JSON.stringify(document()),parsed=parseModel(Buffer.from(raw));
  const located=locateCandidates(raw,parsed,[{item:'d:case',selector:'n/step',text:'合成🧪'}]);
  const claims=prepareClaims(located,[choice,{...choice,category_id:'functional'}],{run:{model_identity:identity}});
  assert.equal(claims.length,2);for(const claim of claims){assert.ok(CategoryJudgmentSchema.safeParse(claim.data).success);assert.deepEqual(claim.data.producer,identity);assert.deepEqual(claim.data.quote,located[0].quotes[0]);}
  const template=readTemplate(TABLE);if(typeof template==='string')throw new Error(template);
  const result=classify(template,{sha256:parsed.source_sha256,model:parsed.model},'d','marked',claims,{[`src:${parsed.source_sha256}`]:raw});
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.missing,[]);assert.deepEqual(result.cases.find(row=>row.id==='d:case')?.categories,['audit_log','functional']);
  assert.deepEqual(declaredIdentity({body:{model_identity:identity}}),identity);
  const configured={...identity,configuration_reference:`src:${'a'.repeat(64)}`};assert.deepEqual(declaredIdentity(configured),configured);
});

test('missing identity, undeclared category and ambiguous or absent quotations never generate claims',()=>{
  const quote={text:'合成',identity:{source_sha256:'a'.repeat(64),parser:'kityminder@1',path:'n/x',span:{unit:'byte',offset:0,length:6}}};
  const located=[{ordinal:1,item:'d:case',quotes:[quote,quote]},{ordinal:2,item:'d:case',quotes:[]}];
  for(const [rows,choices,id] of [
    [located,[choice],identity],
    [located,[{...choice,ordinal:2}],identity],
    [located,[{...choice,quote_index:2}],identity],
    [located,[{...choice,quote_index:0,category_id:'AUDIT_LOG'}],identity],
    [located,[{...choice,quote_index:0}],{model_id:'synthetic'}],
    [[...located,located[0]],[{...choice,quote_index:0}],identity],
  ] as const)assert.throws(()=>prepareClaims(rows,choices,id));
  assert.deepEqual(prepareClaims(located,[{...choice,quote_index:1}],identity)[0].data.quote,quote);
});

test('the local tool writes only a private new file and never prints the original quote',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'synthetic-category-claims-'));
  try{
    const located=join(dir,'located.json'),choices=join(dir,'choices.json'),id=join(dir,'identity.json'),out=join(dir,'out.json');
    const quote={text:'合成私有原文',identity:{source_sha256:'a'.repeat(64),parser:'kityminder@1',path:'n/x',span:{unit:'byte',offset:0,length:6}}};
    await writeFile(located,JSON.stringify([{ordinal:1,item:'d:case',quotes:[quote]}]));await writeFile(choices,JSON.stringify([choice]));await writeFile(id,JSON.stringify(identity));
    const staged=join(dir,'pack');await stagePack(staged);const tool=join(staged,'tools/prepare-claims.ts');
    const invoke=()=>spawnSync(process.execPath,[tool,'--located',located,'--choices',choices,'--identity',id,'--out',out],{encoding:'utf8'});
    const first=invoke();assert.equal(first.status,0,first.stderr);assert.ok(!first.stdout.includes(quote.text));assert.equal((await stat(out)).mode&0o777,0o600);
    const saved=await readFile(out,'utf8');assert.equal(JSON.parse(saved)[0].data.quote.text,quote.text);
    assert.notEqual(invoke().status,0);assert.equal(await readFile(out,'utf8'),saved);
    await writeFile(located,JSON.stringify([{ordinal:1,item:'d:case',quotes:[quote,quote]}]));
    const absent=join(dir,'ambiguous.json'),bad=spawnSync(process.execPath,[tool,'--located',located,'--choices',choices,'--identity',id,'--out',absent],{encoding:'utf8'});
    assert.notEqual(bad.status,0);assert.match(bad.stderr,/多处.*quote_index/);assert.ok(!bad.stderr.includes(quote.text));
    await assert.rejects(readFile(absent),{code:'ENOENT'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
