import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../gold/quotes.ts';
import { runBatch, main, createBatchDeps, type BatchDeps, type Pairings } from './defect-to-case-batch.ts';
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'gold-d2c-synthetic-')),out=join(root,'out');
  const xml='<commands><scope type="global"><menu name="widget"><item name="set"><arguments><arg name="n" type="U16"/></arguments></item><item name="other"/></menu></scope></commands>';
  const commands=join(root,'commands.xml'),manual=join(root,'manual.txt');writeFileSync(commands,xml);writeFileSync(manual,'SYNTHETIC_MANUAL_TEXT');
  const originals=new Map<string,Buffer>();const manualBytes=readFileSync(manual),manualSha=sha256(manualBytes);originals.set(manualSha,manualBytes);
  const details=new Map<string,any>(),submissions=new Map<string,unknown>(),records:string[]=[],reviews:string[][]=[];
  const config:Pairings={product:'Demo',prompt:'{product} {build} 缺陷 {defect}',fix_field:'fix',pairings:[]};
  for(let i=0;i<2;i++){
    const defect=String(160001+i),document=String(24110+i),run=`run_synthetic_${i}`,source=Buffer.from(JSON.stringify({fix:'SYNTHETIC_FIX_QUOTATION',defect})),sourceSha=sha256(source);
    const entrySha=(i?'d':'c').repeat(64),index=Buffer.from(JSON.stringify({schema:'index-view@1',product:'Demo',build:{build:'Demo_1',root:'a'.repeat(64)},kind:'case',key:'commands',keys:{'widget other':[entrySha]},entries:{[entrySha]:{entry:entrySha,kind:'case',statement:'',reference:`tree:${'a'.repeat(64)}/commands/widget/set@${entrySha}`,data:{document:'25000',node:'node-synthetic',title:'DIFFERENT_INDEX_TITLE',negative:false,commands:['widget other']}}},total_keys:1,total_entries:1,truncated:false,skipped:0,notes:[]})),indexSha=sha256(index);
    originals.set(sourceSha,source);originals.set(indexSha,index);
    const record=(i?'f':'e').repeat(64),validation=(i?'2':'1').repeat(64);
    submissions.set(record,{run,items:[{item:'item',slots:{cases:[{data:{title:'SYNTHETIC_DRAFT_TITLE',negative:false,expects_refutation:false,steps:[{command:'widget set 5'}],expected:[{text:'SYNTHETIC_FIX_QUOTATION',quote:{text:'SYNTHETIC_FIX_QUOTATION',reference:`src:${sourceSha}/json@1/p/fix`}}]}}]}}]});
    const requirements=['fields','commands','grounded','not_duplicate','traceability'];
    const detail={run:{run,pack:'defect-to-case@1.0.0',pack_digest:'b'.repeat(64),root:'a'.repeat(64),sources:[{slot:'defects',reference:`src:${sourceSha}`},{slot:'indexed_cases',reference:`src:${indexSha}`},{role:'expected',external:'manual:cli:10.6.1',reference:`src:${manualSha}`}],requirements:requirements.map(key=>({key,repair_rounds:2}))},submissions:[{record,result:validation,acceptance:'accepted'},{record:'3'.repeat(64),result:null,acceptance:'not_accepted'}],latest:{record:validation,result:{schema:'validation@1',submission:'4'.repeat(64),rounds:{used:1,max:2},partitions:{delivered:[{item:'item',requirements:requirements.map(requirement=>({requirement,status:'satisfied',claims:[]}))}]}}}};
    details.set(run,detail);
    const map=join(root,`map-${i}.json`);writeFileSync(map,JSON.stringify({root:{data:{text:`缺陷${defect} 回归`,id:'root'},children:[{data:{text:'widget set 5',id:'case',resource:['功能']}}]}}));
    config.pairings.push({defect,build:'Demo_1',commands,manual,regression_map:map,document});
  }

  const deps:BatchDeps={assertAdmin:async()=>{},now:()=>new Date('2026-10-23T00:00:00Z'),review:async args=>{reviews.push(args);return {complete:true,calls:JSON.stringify({at:'2026-10-23T00:00:00Z',tool:'start_run',run:`run_synthetic_${args[args.indexOf('--prompt')+1].includes('160002')?1:0}`})};},show:async id=>details.get(id),submission:async record=>{records.push(record);return submissions.get(record);},exportOriginal:async(sha,path)=>{const b=originals.get(sha);if(!b)throw new Error('missing synthetic original');writeFileSync(path,b);}};
  return {root,out,config,deps,records,reviews,details,submissions,originals,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('two pairings aggregate counts and select the accepted submission by latest.record, without revealing content',async()=>{
  const f=fixture();try{
    const report=await runBatch(f.config,{out:f.out,endpointArgs:['--endpoint-from','circle'],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.deepEqual([report.totals.completed,report.totals.drafts,report.totals.domain_support],[2,2,2]);
    assert.deepEqual(f.records,['e'.repeat(64),'f'.repeat(64)]);
    assert.notEqual(f.details.get('run_synthetic_0').latest.result.submission,f.records[0]);
    assert.notEqual(f.reviews[0][f.reviews[0].indexOf('--out')+1],f.reviews[1][f.reviews[1].indexOf('--out')+1]);
    for(const text of ['SYNTHETIC_DRAFT_TITLE','widget set','SYNTHETIC_FIX_QUOTATION','160001','160002','24110','24111'])assert.ok(!report.text.includes(text),text);
    const detail=readFileSync(join(f.out,'pair-1','details.json'),'utf8');
    for(const text of ['SYNTHETIC_DRAFT_TITLE','widget set','SYNTHETIC_FIX_QUOTATION','run_synthetic'])assert.ok(!detail.includes(text));
    assert.equal(statSync(join(f.out,'pair-1','details.json')).mode&0o777,0o600);
    assert.equal(statSync(f.out).mode&0o777,0o700);
  }finally{f.close();}
});
test('a root title without the pairing defect is refused without launching the client',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);f.config.pairings[0].defect='160009';
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);assert.equal(report.code,2);assert.equal(f.reviews.length,0);assert.match(report.text,/root_defect_mismatch/);
  }finally{f.close();}
});
test('an iteration without a defect-to-case run is reported separately',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);f.details.get('run_synthetic_0').run.pack='other@1.0.0';
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);assert.equal(report.code,1);assert.match(report.text,/no_defect_to_case_run/);assert.equal(f.records.length,0);
  }finally{f.close();}
});
test('the last eligible validation wins, while a later run without a validation does not',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);
    f.deps.review=async()=>({complete:true,calls:['old','run_synthetic_0','later'].map(run=>JSON.stringify({at:'2026-10-23T00:00:00Z',tool:'start_run',run})).join('\n')});
    f.details.set('old',f.details.get('run_synthetic_1'));f.details.set('later',{run:{pack:'defect-to-case@1.0.0'},latest:null});
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);assert.equal(report.code,0);assert.deepEqual(f.records,['e'.repeat(64)]);assert.match(report.text,/运行 3/);
  }finally{f.close();}
});
test('incomplete index coverage cannot pass a batch',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);
    const original=f.deps.exportOriginal;f.deps.exportOriginal=async(sha,path)=>{await original(sha,path);const text=readFileSync(path,'utf8');if(text.includes('index-view@1'))writeFileSync(path,text.replace('"truncated":false','"truncated":true'));};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);assert.equal(report.code,1);assert.match(report.text,/export_integrity_mismatch/);
  }finally{f.close();}
});
test('CLI refuses usage errors without touching any external dependency',async()=>{
  assert.equal(await main(['--home','synthetic']),2);
});
test('a corrupted export is automatically reread and verified before comparison',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const original=f.deps.exportOriginal;let calls=0;
    f.deps.exportOriginal=async(sha,path)=>{if(calls++===0)writeFileSync(path,'synthetic corruption');else await original(sha,path);};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.ok(report.totals.recovery_actions>0);assert.equal(report.totals.design_gaps,0);
  }finally{f.close();}
});
test('the absent expected-text branch is a definite pack to-do and title recount remains the gate',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const detail=f.details.get('run_synthetic_0'),binding=detail.run.sources.find((s:any)=>s.slot==='indexed_cases');
    const old=binding.reference.slice(4),index=JSON.parse(f.originals.get(old)!.toString());
    index.keys={'widget set':Object.keys(index.entries)};for(const e of Object.values(index.entries) as any[])e.data.commands=['widget set'];
    const bytes=Buffer.from(JSON.stringify(index)),digest=sha256(bytes);f.originals.set(digest,bytes);binding.reference=`src:${digest}`;
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.equal(report.totals.design_gaps,0);
    assert.match(report.text,/没法重算.*影响草稿 1.*requirements.json:70/);
  }finally{f.close();}
});
test('a pending requirement fails without writing or replacing the observed Hub result',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const detail=f.details.get('run_synthetic_0');
    detail.latest.result.partitions.delivered[0].requirements.find((r:any)=>r.requirement==='commands').status='pending';let writes=0;
    Object.assign(f.deps,{replaySubmission:async()=>{writes++;}});
    const before=JSON.stringify(detail),report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(writes,0);assert.equal(report.code,1);assert.equal(JSON.stringify(detail),before);
  }finally{f.close();}
});
test('an explicit retry option reruns unfinished client work once',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const review=f.deps.review;let attempts=0;
    f.deps.review=async(args,out)=>++attempts===1?{calls:'',complete:true}:review(args,out);
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic',retries:1},f.deps);
    assert.equal(attempts,2);assert.equal(report.code,0);assert.ok(report.totals.recovery_actions>0);
  }finally{f.close();}
});
test('a referenced stored original is exported automatically, then a forbidden source is a definite finding',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const bytes=Buffer.from('ADDITIONAL_SYNTHETIC_SOURCE'),digest=sha256(bytes);f.originals.set(digest,bytes);
    const submission=f.submissions.get('e'.repeat(64)) as any;
    submission.items[0].slots.cases[0].data.expected=[{text:'ADDITIONAL_SYNTHETIC_SOURCE',quote:{text:'ADDITIONAL_SYNTHETIC_SOURCE',reference:`src:${digest}`}}];
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,1);assert.equal(report.totals.quote_unknown,0);assert.equal(report.totals.design_gaps,0);assert.equal(report.totals.defects,1);assert.ok(report.totals.recovery_actions>0);
  }finally{f.close();}
});
test('an unreadable run is not falsely reported as absent after the automatic reread',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);let reads=0;
    f.deps.show=async()=>{reads++;throw new Error('PRIVATE_TRANSPORT_DETAIL');};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,1);assert.equal(reads,2);assert.match(report.text,/run_record_read_defect/);assert.doesNotMatch(report.text,/no_defect_to_case_run|PRIVATE_TRANSPORT_DETAIL/);
  }finally{f.close();}
});
test('missing repair-round facts fail without resubmitting the accepted body',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);delete f.details.get('run_synthetic_0').latest.result.rounds;
    let writes=0;Object.assign(f.deps,{replaySubmission:async()=>{writes++;}});
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(writes,0);assert.equal(report.code,1);assert.equal(report.totals.design_gaps,0);assert.equal(report.totals.defects,1);
    assert.ok(JSON.parse(readFileSync(join(f.out,'pair-1','details.json'),'utf8')).positions.some((p:any)=>p.category==='hub_output_missing'));
  }finally{f.close();}
});
test('every bound src original is exported, including an unused expected manual',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const bytes=Buffer.from('BOUND_MANUAL_ORIGINAL'),digest=sha256(bytes),exports:string[]=[];
    f.originals.set(digest,bytes);f.details.get('run_synthetic_0').run.sources.push({reference:`src:${digest}`,role:'expected',external:'manual:cli:12.1'});
    const original=f.deps.exportOriginal;f.deps.exportOriginal=async(sha,path)=>{exports.push(sha);await original(sha,path);};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.ok(exports.includes(digest));assert.deepEqual(readFileSync(join(f.out,'pair-1',digest)),bytes);
  }finally{f.close();}
});
test('a canonical received.object envelope is unwrapped from verified original bytes before accepting drafts',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const record='e'.repeat(64),body={...(f.submissions.get(record) as object),notes:'\ud800'},bytes=Buffer.from(JSON.stringify(body)),digest=sha256(bytes);
    f.originals.set(digest,bytes);f.submissions.set(record,{received:{object:digest,size:bytes.length,non_canonical_path:'/notes',run:'run_synthetic_0'}});
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.equal(report.totals.drafts,1);assert.deepEqual(readFileSync(join(f.out,'pair-1',digest)),bytes);
  }finally{f.close();}
});
test('fake child stdout and stderr for every process stay in private pairing evidence, never on screen',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const marker='PRIVATE_SYNTHETIC_MODEL_HOST',calls:string[]=[];
    f.details.get('run_synthetic_0').run.instructions=marker;
    const deps=createBatchDeps({out:f.out,endpointArgs:[],token:'PRIVATE_SYNTHETIC_TOKEN'},(args)=>{
      if(args[0]==='scripts/real/review-circle.ts'){
        calls.push('review');const out=args[args.indexOf('--out')+1];
        writeFileSync(join(out,'pair.calls.jsonl'),JSON.stringify({at:new Date().toISOString(),tool:'start_run',run:'run_synthetic_0'}));
        return {status:0,stdout:marker,stderr:marker};
      }
      if(args[1]==='original'&&args[2]==='list'){calls.push('admin');return {status:0,stdout:marker,stderr:marker};}
      if(args[1]==='run'){calls.push('show');return {status:0,stdout:JSON.stringify(f.details.get('run_synthetic_0')),stderr:marker};}
      calls.push('export');writeFileSync(args[args.indexOf('--out')+1],f.originals.get(args[3])!);return {status:0,stdout:marker,stderr:marker};
    },async(_options,requests)=>requests.map(request=>{
      const record=(request.args as {reference:string}).reference.slice(4);
      return {isError:false,text:marker,structured:{content:{text:JSON.stringify(f.submissions.get(record))}}};
    }));
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},deps);
    assert.equal(report.code,0);assert.ok(!report.text.includes(marker));assert.ok(!report.text.includes('PRIVATE_SYNTHETIC_TOKEN'));
    assert.equal(report.text.split('\n').filter(line=>line.startsWith('配对 ')).length,1);
    assert.deepEqual(calls,['admin','review','show','export','export','export']);
    const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);
    const captures=files(f.out).filter(path=>/process-.*\.(stdout|stderr)\.txt$/.test(path));
    assert.equal(captures.length,12);assert.ok(captures.some(path=>readFileSync(path,'utf8').includes(marker)));
    for(const path of captures)assert.equal(statSync(path).mode&0o777,0o600);
  }finally{f.close();}
});
test('the negative preparation-step difference is counted by item with positional details and still exits nonzero',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const submission=f.submissions.get('e'.repeat(64)) as any,data=submission.items[0].slots.cases[0].data;
    data.negative=true;data.expects_refutation=true;data.steps=[{command:'widget set 5'},{command:'widget set 70000'}];
    f.details.get('run_synthetic_0').latest.result.partitions.delivered[0].requirements.find((r:any)=>r.requirement==='commands').status='unsatisfied';
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,1);assert.equal(report.totals.known_step_rule_items,1);assert.equal(report.totals.known_simplified_match_items,0);
    const details=JSON.parse(readFileSync(join(f.out,'pair-1','details.json'),'utf8'));
    assert.ok(details.positions.some((p:any)=>p.draft===1&&p.step===1&&p.category==='negative_step_rule'));
  }finally{f.close();}
});

test('every pairing is checked before the first client is launched',async()=>{
  const f=fixture();try{f.config.pairings[1].commands=join(f.root,'absent.xml');
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,2);assert.equal(f.reviews.length,0);assert.match(report.text,/配对 2\/2.*commands/);assert.doesNotMatch(report.text,/absent.xml/);
  }finally{f.close();}
});
test('admin preflight refuses before client work and export permission failures are not Hub defects',async()=>{
  const f=fixture();try{let clients=0;f.deps.review=async()=>{clients++;throw new Error('PRIVATE_CLIENT');};
    f.deps.assertAdmin=async()=>{throw new Error('PRIVATE_TOKEN');};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,2);assert.equal(clients,0);assert.match(report.text,/admin_preflight/);assert.equal(report.totals.defects,0);assert.doesNotMatch(report.text,/PRIVATE/);
  }finally{f.close();}
});
test('client and export failures keep their own causes without claiming integrity defects',async()=>{
  for(const mode of ['client','export']){const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);
    if(mode==='client')f.deps.review=async()=>{throw new Error('PRIVATE_FAILURE');};
    else f.deps.exportOriginal=async()=>{throw new Error('PRIVATE_FAILURE');};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,1);assert.equal(report.totals.defects,0);assert.match(report.text,mode==='client'?/client_run_failed/:/export_refused/);assert.doesNotMatch(report.text,/PRIVATE/);
  }finally{f.close();}}
});
test('batch consumes an exported product declaration for enum case matching and records its digest',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);
    writeFileSync(f.config.pairings[0].commands,'<commands><menu name="widget"><item name="set"><arguments><arg name="" type="STRING" limit="{on|off}"/></arguments></item></menu></commands>');
    (f.submissions.get('e'.repeat(64)) as any).items[0].slots.cases[0].data.steps=[{command:'widget set ON'}];
    const declaration=Buffer.from(JSON.stringify({schema:'product@1',catalogs:[{id:'commands@1',complete:true,case_sensitive:false}]}));
    f.config.product_declaration=join(f.root,'product.json');writeFileSync(f.config.product_declaration,declaration);
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.equal(report.totals.domain_unknown,0);assert.ok(report.text.includes(sha256(declaration)));
  }finally{f.close();}
});

test('follow-ups record vocabulary reasons and a written file without claiming a sent request',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);
    const path=f.config.pairings[0].commands;writeFileSync(path,readFileSync(path,'utf8').replace('type="U16"','type="DEPLOYMENT"'));
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,1);const questions=JSON.parse(readFileSync(join(f.out,'pair-1','followup.json'),'utf8'));
    assert.ok(questions.some((q:any)=>q.reason==='no_check'));assert.ok(questions.every((q:any)=>!('action_status' in q)));
    assert.match(report.text,/清单已写入/);assert.doesNotMatch(report.text,/已请求|已发送/);
  }finally{f.close();}
});

test('a skipped task launches the client only once unless retries were explicitly requested',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);let attempts=0;f.deps.review=async()=>{attempts++;return {calls:'',complete:true};};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(attempts,1);assert.equal(report.code,1);assert.match(report.text,/no_defect_to_case_run/);
    assert.ok(JSON.parse(readFileSync(join(f.out,'pair-1','followup.json'),'utf8')).some((q:any)=>q.next_action==='rerun_pairing_with_explicit_retries'));
  }finally{f.close();}
});

test('supplemental index bytes are frozen before client work and their digest reaches the pairing line',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const detail=f.details.get('run_synthetic_0');
    const bound=detail.run.sources.find((source:any)=>source.slot==='indexed_cases').reference.slice(4);
    const view=JSON.parse(f.originals.get(bound)!.toString());view.notes=['PRIVATE_INDEX_NOTE'];
    const bytes=Buffer.from(JSON.stringify(view)),path=join(f.root,'supplemental.json');writeFileSync(path,bytes);f.config.pairings[0].indexes=[path];
    const review=f.deps.review;f.deps.review=async(args,out)=>{writeFileSync(path,'changed after preflight');return review(args,out);};
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.ok(report.text.includes(sha256(bytes)));assert.doesNotMatch(report.text,/PRIVATE_INDEX_NOTE/);
  }finally{f.close();}
});
test('a pairing manual must match an expected manual actually bound to the run',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);writeFileSync(f.config.pairings[0].manual,'UNBOUND_SYNTHETIC_MANUAL');
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,1);assert.match(report.text,/pairing_manual_binding_mismatch/);assert.equal(report.totals.defects,0);assert.equal(report.totals.design_gaps,0);
  }finally{f.close();}
});
test('all expected manuals bound to the run are recognized as manual quote targets',async()=>{
  const f=fixture();try{f.config.pairings=f.config.pairings.slice(0,1);const bytes=Buffer.from('SECOND_BOUND_MANUAL'),digest=sha256(bytes);f.originals.set(digest,bytes);
    f.details.get('run_synthetic_0').run.sources.push({role:'expected',external:'manual:app:10.6.1',reference:`src:${digest}`});
    (f.submissions.get('e'.repeat(64)) as any).items[0].slots.cases[0].data.expected=[{text:bytes.toString(),quote:{text:bytes.toString(),reference:`src:${digest}`}}];
    const report=await runBatch(f.config,{out:f.out,endpointArgs:[],token:'synthetic'},f.deps);
    assert.equal(report.code,0);assert.equal(report.totals.quote_manual_support,1);assert.equal(report.totals.quote_other_support,0);
  }finally{f.close();}
});
