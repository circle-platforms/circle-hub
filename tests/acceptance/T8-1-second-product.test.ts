// T8-1 drives the same published workflows against two synthetic product catalogs.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { PARTITION } from '../../contracts/generated/vocabulary.ts';
import { MissingFact, UnknownExit } from '../../contracts/src/recovery.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { startStub, json } from '../../hub/connectors/testing/stub.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { productPacks } from './support/env.ts';
import { openBed } from './support/hub.ts';
import { draft, startReview, resultOf } from './support/review.ts';

// Compare the public result schema and actual terminals without substituting product-specific text or volatile references.
const shape = (result:ValidationResult) => ({
  acceptance:result.acceptance,
  partitions:Object.fromEntries(PARTITION.map(p=>[p,result.partitions[p].map(item=>({
    requirements:item.requirements.map(r=>({requirement:r.requirement,status:r.status,unsatisfied_reason:r.unsatisfied_reason??null,layers:r.layers.map(l=>({layer:l.layer,terminal:l.terminal,reason:l.reason??null}))})),
  }))])),
});

test('T8-1 Lumen and ORBIT use identical review and defect-to-case workflows and result contracts',async t=>{
  const postgres=await startPostgres();t.after(()=>postgres.stop());
  const bed=await openBed({postgres});t.after(()=>bed.close());
  await bed.hub.assignPack(bed.reviewer.principal,'defect-to-case');
  const plm=await startStub(request=>request.path==='/plmquery/bug/detail/'?json({code:1000,data:[{id:'910001',title:'合成查询修复',status:'fixed',repair:'查询返回 ready'}]}):json({code:1000,data:[]}));
  t.after(()=>plm.close());
  assert.ok(bed.resources.plm);
  await bed.hub.hub.connectors.admin.updateResource(bed.hub.admin.principal,bed.resources.plm.id,{origins:{...bed.resources.plm.origins,'plm-api':plm.origin},allow_plaintext:[new URL(bed.resources.plm.origins['plm-oauth']).origin,plm.origin],settings:{bug_fix_field:'repair'}});
  await bed.hub.setCredential(bed.resources.plm.id,'username',bed.hub.stubs!.agileAccount.username);
  await bed.hub.setCredential(bed.resources.plm.id,'password',bed.hub.stubs!.agileAccount.password);
  const client=await bed.connect(bed.reviewer,'synthetic-two-products');
  const subject=await client.upload(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成观察'},children:[{data:{id:'case',text:'合成用例',priority:2,resource:['functional']},children:[{data:{id:'expect',text:'ready'}}]}]}})),'synthetic-two-products.km.json');
  const products=[{product:bed.product,version:bed.site.LINE,sync:bed.syncs.two!,absentTerminal:'violation' as const},{product:bed.second,version:'2.1',sync:bed.syncs.one!,absentTerminal:'unchecked' as const}];
  const reviews:ValidationResult[]=[], defects:ValidationResult[]=[];
  for(const {product,version,sync,absentTerminal} of products){
    const review=await startReview(client,{product:product.names[0],version,inputs:{subject:{reference:subject}}});
    assert.equal(review.product,product.line);
    const reviewed=await client.call('submit_result',draft(review));assert.equal(reviewed.out.acceptance,'accepted',reviewed.text);reviews.push(resultOf(reviewed));
    const build=sync.builds.find(b=>b.root);assert.ok(build);
    const started=await client.call('start_run',{pack:'defect-to-case',product:product.names[0],version,inputs:{defects:[{external:'plm:bug:910001'}],indexed_cases:{external:`knowledge:index:${product.line}:${build.name}?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure`}}});
    assert.equal(started.isError,false,started.text);
    const run=started.out.run!;
    assert.equal(run.product,product.line);assert.equal(run.items.length,1);
    const source=run.sources.find(s=>s.slot==='defects');assert.ok(source);
    const quote={reference:`${source.reference}/json@1/p/fields/repair`,text:'ready'};
    const command=product.line===bed.second.line?'GET /v1/pools':'show health detail';
    const data={id:'synthetic-draft',title:'合成查询检查',priority:2,negative:false,expects_refutation:false,preconditions:[],steps:[{command}],expected:[{after:1,text:'ready',quote}],resource:['functional'],tags:['functional']};
    const payload={run:run.run,model:'synthetic-drafter',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{cases:[{text:data.title,quotes:[quote],data}]}}))};
    const bad=structuredClone(payload);bad.items[0].slots.cases[0].quotes[0].text='not in the source';
    const refused=await client.call('submit_result',bad);assert.equal(refused.out.acceptance,'not_accepted');assert.ok(refused.out.errors.some(e=>e.code==='QUOTE_MISMATCH'));
    const nonexistent=structuredClone(payload);nonexistent.items[0].slots.cases[0].data.steps[0].command='synthetic missing command';
    const contradicted=await client.call('submit_result',nonexistent);assert.equal(contradicted.out.acceptance,'accepted',contradicted.text);
    const rejectedCommands=Object.values(contradicted.out.result!.partitions).flat().flatMap(item=>item.requirements).filter(r=>r.requirement==='commands');
    assert.ok(rejectedCommands.length>0);
    for(const requirement of rejectedCommands){
      assert.notEqual(requirement.status,'satisfied','an absent command is never established by either catalog');
      for(const layer of requirement.layers){
        assert.equal(layer.terminal,absentTerminal,'the fixture declaration fixes completeness, never the observed answer');
        if(layer.terminal==='unchecked'){
          assert.equal(requirement.status,'pending');
          assert.equal(layer.reason,'integrity_unproven');
          MissingFact.parse(layer.missing);UnknownExit.parse(layer.exit);
          assert.ok(requirement.claims.some(c=>c.statement.verdict==='unknown'));
        }else{
          assert.equal(layer.terminal,'violation');assert.equal(requirement.status,'unsatisfied');
          assert.ok(requirement.claims.some(c=>c.statement.verdict==='refute'&&c.statement.code==='core.catalog.not_member'));
        }
      }
    }
    const accepted=await client.call('submit_result',payload);assert.equal(accepted.out.acceptance,'accepted',accepted.text);defects.push(resultOf(accepted));
    assert.ok(Object.values(accepted.out.result!.partitions).flat().every(item=>item.requirements.find(r=>r.requirement==='commands')?.status==='satisfied'),'each product command parses against its actual locked catalog');
    assert.ok(Object.values(accepted.out.result!.partitions).flat().some(item=>item.requirements.some(r=>r.requirement==='grounded'&&r.status==='satisfied')),'the draft expectation was grounded, not merely skipped');
  }
  assert.deepEqual(shape(reviews[0]),shape(reviews[1]));
  assert.deepEqual(shape(defects[0]),shape(defects[1]));
});

test('T8-1 production core contains no product identity literals',async()=>{
  const root=new URL('../../hub/',import.meta.url).pathname;
  const forbidden=new Set((await productPacks()).flatMap(product=>[product.id,product.line,...product.names]));
  const violations:string[]=[];
  async function visit(dir:string):Promise<void>{
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.name==='testing')continue;
      const path=join(dir,entry.name);
      if(entry.isDirectory()){await visit(path);continue;}
      if(!entry.name.endsWith('.ts')||entry.name.endsWith('.test.ts')||entry.name.startsWith('testing'))continue;
      const ast=ts.createSourceFile(path,await readFile(path,'utf8'),ts.ScriptTarget.Latest,true);
      function walk(node:ts.Node){
        if(ts.isStringLiteralLike(node)&&forbidden.has(node.text))violations.push(`${path.slice(root.length)}:${ast.getLineAndCharacterOfPosition(node.getStart()).line+1}`);
        ts.forEachChild(node,walk);
      }
      walk(ast);
    }
  }
  await visit(root);assert.deepEqual(violations,[]);
});
