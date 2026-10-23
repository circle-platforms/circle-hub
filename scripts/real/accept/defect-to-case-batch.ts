// Integrator-only driver. Pairing JSON: {product,prompt,fix_field,pairings:[{defect,build,commands,manual,regression_map,document,indexes?}]}.
// Optional product_declaration names an exported product@1 JSON file; compare CLI uses --product for the same input.
// --retries N explicitly budgets extra client turns (default zero); re-reading stored evidence never resubmits a run.
// Original files, pairing lists, client evidence and positional reports stay outside every Git worktree.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, chmodSync, lstatSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIREMENT_STATUS, VERDICT,REASON,labelOf } from '../../../contracts/generated/vocabulary.ts';
import {commandCatalogDeclaration} from '../gold/compile-check.ts';
import { regressionDocGold } from '../gold/regression-doc.ts';
import { object, locatedDrafts, decodeCommandXml, commandDomains } from '../gold/command-domains.ts';
import { sha256 } from '../gold/quotes.ts';
import { recountDuplicates } from '../gold/dup-recount.ts';
import { parseCallLog } from '../review-circle.ts';
import { callTools } from '../hub-call.ts';
import { computeComparison, comparisonDetails, renderComparison, outsideGit, writePrivateJson, evidenceQuestions, type EvidenceQuestion, type Comparison } from './defect-to-case-compare.ts';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const MISSING=REASON.find(reason=>reason==='missing_input')!,INTEGRITY=REASON.find(reason=>reason==='integrity_unproven')!;
const HEX=/^[a-f0-9]{64}$/;
const validRounds=(result:any)=>object(result.rounds)&&Number.isInteger(result.rounds.used)&&Number.isInteger(result.rounds.max)&&result.rounds.used>=0&&result.rounds.used<=result.rounds.max;
export interface Pairing {defect:string;build:string;commands:string;manual:string;regression_map:string;document:string;indexes?:string[]}
export interface Pairings {product:string;prompt:string;fix_field:string;pairings:Pairing[];product_declaration?:string}
export interface BatchOptions {out:string;endpointArgs:string[];token:string;url?:string;retries?:number}
export interface BatchDeps {
  assertAdmin(evidenceDir:string):Promise<void>;
  review(args:string[],out:string):Promise<{calls:string;complete:boolean}>;
  show(run:string):Promise<unknown>;
  submission(record:string):Promise<unknown>;
  exportOriginal(sha:string,path:string):Promise<void>;
  now():Date;
}
export function validatePairings(value:unknown):Pairings {
  if(!object(value)||!['product','prompt','fix_field'].every(k=>typeof value[k]==='string'&&value[k].trim()!=='')||!Array.isArray(value.pairings)||value.pairings.length===0)throw new Error('invalid pairings');
  if(value.product_declaration!==undefined&&(typeof value.product_declaration!=='string'||!value.product_declaration.trim()))throw new Error('invalid product declaration path');
  if(!['{defect}','{product}','{build}'].every(k=>value.prompt.includes(k)))throw new Error('missing template placeholders');
  for(const p of value.pairings)if(!object(p)||!['defect','build','commands','manual','regression_map','document'].every(k=>typeof p[k]==='string'&&p[k].trim()!=='')||!/^\d+$/.test(p.defect)||!/^\d+$/.test(p.document)||(p.indexes!==undefined&&(!Array.isArray(p.indexes)||p.indexes.some((s:unknown)=>typeof s!=='string'))))throw new Error('invalid pairing');
  return value as Pairings;
}
function lockEvidence(path:string):void {
  const stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error('unsafe evidence');
  chmodSync(path,stat.isDirectory()?0o700:0o600);
  if(stat.isDirectory())for(const name of readdirSync(path))lockEvidence(join(path,name));
}
function gates(c:Comparison) {
  const p=c.parameters,q=c.quoteOracle;
  return {commands:!!p&&p.domains.items.length>0&&p.domains.items.every(i=>i.comparison==='equal'&&!i.hasUnknown),
    quotes:q.shapes.length===0&&q.details.length>0&&q.counts.refute===0&&q.counts.unknown===0&&q.items.every(i=>i.comparison==='equal'),
    origins:q.details.length>0&&q.details.every(d=>d.category==='fix'||d.category==='manual')};
}
export async function runBatch(config:Pairings,options:BatchOptions,deps:BatchDeps):Promise<{code:number;text:string;totals:Record<string,number>}> {
  validatePairings(config);
  const retries=options.retries??0;if(!Number.isInteger(retries)||retries<0||retries>10)throw new Error('invalid retries');
  const prepared=[];
  for(const [position,pair] of config.pairings.entries()){
    let field='commands',cause='pairing_input_invalid';
    try{
      const commandBytes=readFileSync(outsideGit(pair.commands)),xml=decodeCommandXml(commandBytes);commandDomains(xml);
      field='product_declaration';const declarationBytes=config.product_declaration?readFileSync(outsideGit(config.product_declaration)):undefined;
      const commandCatalog=declarationBytes?commandCatalogDeclaration(JSON.parse(declarationBytes.toString('utf8'))):undefined;
      field='manual';const manual=readFileSync(outsideGit(pair.manual));
      field='regression_map';const mapBytes=readFileSync(outsideGit(pair.regression_map)),map=JSON.parse(mapBytes.toString('utf8'));
      const gold=regressionDocGold(pair.document,map,{commandTreeXml:xml});
      if(!gold.defects.includes(pair.defect)){cause='root_defect_mismatch';throw new Error();}
      field='indexes';const extraIndexes=(pair.indexes??[]).map(path=>{const bytes=readFileSync(outsideGit(path));return {bytes,view:JSON.parse(bytes.toString('utf8'))};});
      if(extraIndexes.length)recountDuplicates(extraIndexes.map(index=>index.view),{items:[]},xml,{});
      prepared.push({commandBytes,xml,manual,mapBytes,gold,commandCatalog,declarationBytes,extraIndexes});
    }catch{return {code:2,text:`配对 ${position+1}/${config.pairings.length}：输入不通过；字段 ${field}；${cause}`,totals:{pairs:config.pairings.length,completed:0,failed:1,defects:0}};}
  }
  const out=outsideGit(options.out);mkdirSync(out,{recursive:true,mode:0o700});
  if(readdirSync(out).length!==0)throw new Error('output is not empty');chmodSync(out,0o700);
  const preflightDir=join(out,'pair-1');mkdirSync(preflightDir,{mode:0o700});
  try{await deps.assertAdmin(preflightDir);}catch{lockEvidence(preflightDir);return {code:2,text:'配对 1：输入不通过；字段 token；admin_preflight',totals:{pairs:config.pairings.length,completed:0,failed:1,defects:0}};}
  const lines:string[]=[],totals:Record<string,number>={pairs:config.pairings.length,completed:0,known_step_rule_items:0,known_simplified_match_items:0,command_gate_pass:0,quote_gate_pass:0,origin_gate_pass:0,duplicate_gate_pass:0,design_gaps:0,defects:0,failed:0,recovery_actions:0,drafts:0,commands:0,domain_support:0,domain_refute:0,domain_unknown:0,quote_support:0,quote_refute:0,quote_unknown:0,paraphrased:0,head_draft:0,head_doc:0,head_shared:0,pair_draft:0,pair_doc:0,pair_shared:0,parameter_same:0,parameter_different:0,parameter_absent:0,expected_verbatim:0,necessary_only:0,expected_branch_affected:0};
  for(const [position,pair] of config.pairings.entries()) {
    const ordinal=position+1,dir=join(out,`pair-${ordinal}`);mkdirSync(dir,{recursive:true,mode:0o700});
    const pairLine=lines.length;
    let category='pairing_originals_missing',seenRuns=0;
    const actions:{position:number;attempt:number;category:string}[]=[],requests:EvidenceQuestion[]=[];
    const performed=(category:string,attempt:number)=>{actions.push({position:actions.length+1,attempt,category});totals.recovery_actions++;};
    try {
      const {commandBytes,xml,manual,mapBytes,gold,commandCatalog,declarationBytes,extraIndexes}=prepared[position];
      const prompt=config.prompt.replace(/\{(defect|product|build)\}/g,(_,key:string)=>key==='product'?config.product:pair[key as 'defect'|'build']);
      let selected:any;
      const allRuns=new Map<string,any>();
      // Extra client/model turns require an explicit retry budget in the integrator command.
      for(let attempt=1;attempt<=1+retries&&!selected;attempt++) {
        const reviewDir=join(dir,`review-${attempt}`);mkdirSync(reviewDir,{mode:0o700});
        const from=deps.now().getTime();
        category='client_run_failed';
        const review=await deps.review([...options.endpointArgs,'--prompt',prompt,'--out',reviewDir,'--name','pair'],reviewDir);
        const to=deps.now().getTime();lockEvidence(reviewDir);
        if(attempt>1)performed('rerun_unfinished_client_work',attempt);
        const ids=[...new Set(parseCallLog(review.calls).filter(l=>l.tool==='start_run'&&typeof l.run==='string'&&Date.parse(l.at)>=from&&Date.parse(l.at)<=to).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).map(l=>l.run!))];
        const eligible:any[]=[];let unresolvedRun=false;
        for(const id of ids) {
          let detail:unknown;
          for(let read=1;read<=2;read++) {
            try{detail=await deps.show(id);if(detail)break;}catch{}
            performed('reread_run_record',read);
          }
          if(!object(detail)||!object(detail.run))unresolvedRun=true;
          if(object(detail)&&object(detail.run)&&typeof detail.run.pack==='string'&&/^defect-to-case@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(detail.run.pack)) {
            allRuns.set(id,detail);
            if(object(detail.latest)&&object(detail.latest.result)&&HEX.test(detail.latest.record))eligible.push(detail);
          }
        }
        seenRuns=allRuns.size;
        if(review.complete&&eligible.length&&!unresolvedRun)selected=eligible.at(-1);
        else category=!review.complete?'client_work_incomplete':unresolvedRun?'run_record_read_defect':seenRuns?'no_validation':'no_defect_to_case_run';
      }
      if(!selected)throw new Error(category);
      const run=selected.run;let result=selected.latest.result;
      if(!HEX.test(run.pack_digest)||!HEX.test(run.root)||!Array.isArray(run.sources)||!Array.isArray(run.requirements)||!Array.isArray(selected.submissions)||result.schema!=='validation@1'){category='invalid_run';throw new Error(category);}
      const accepted=selected.submissions.filter((s:any)=>s.result===selected.latest.record&&s.acceptance==='accepted');
      if(accepted.length!==1||!HEX.test(accepted[0].record)){category='accepted_submission_missing';throw new Error(category);}
      const sources=new Map<string,Uint8Array>(),indexes:unknown[]=[],slots=new Set<string>();
      let sourcePosition=0;
      const obtain=async(digest:string,recovery=false):Promise<Uint8Array>=>{
        if(sources.has(digest))return sources.get(digest)!;
        const source=++sourcePosition;
        let integrityMismatch=false;
        for(let attempt=1;attempt<=2;attempt++) {
          const path=join(dir,`${digest}.attempt-${attempt}`);
          if(recovery||attempt>1)performed('export_original_and_recompute',attempt);
          try {
            await deps.exportOriginal(digest,path);const bytes=readFileSync(path);chmodSync(path,0o600);
            if(sha256(bytes)!==digest){integrityMismatch=true;continue;}
            renameSync(path,join(dir,digest));sources.set(digest,bytes);return bytes;
          }catch{}
        }
        category=integrityMismatch?'export_integrity_mismatch':'export_refused';
        requests.push({category:'design_gap',reason:integrityMismatch?INTEGRITY:MISSING,missing_fact:`verified_source_original_${source}`,next_action:'repair_original_export_then_rerun',owner:'Claude'});
        throw new Error(category);
      };
      let submission:unknown;
      for(let attempt=1;attempt<=2;attempt++) {
        try {
          const body=await deps.submission(accepted[0].record);
          if(object(body)&&object(body.received)&&HEX.test(body.received.object)) {
            const bytes=await obtain(body.received.object,true);
            if(body.received.size!==undefined&&body.received.size!==bytes.byteLength)throw new Error('received size mismatch');
            submission=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
          } else submission=body;
          if(object(submission)&&submission.run===run.run)break;
        } catch(error) { if(category==='export_integrity_mismatch'||category==='export_refused')throw error; }
        performed('reread_accepted_submission',attempt);
      }
      if(!object(submission)||submission.run!==run.run){category='submission_identity_mismatch';throw new Error(category);}
      for(const binding of run.sources){
        const digest=typeof binding.reference==='string'?/^src:([a-f0-9]{64})(?:\/|$)/.exec(binding.reference)?.[1]:undefined;
        if(!digest){if(binding.slot==='defects'||binding.slot==='indexed_cases'){category='source_binding_invalid';throw new Error(category);}continue;}
        if(binding.slot==='defects'||binding.slot==='indexed_cases')slots.add(binding.slot);const bytes=await obtain(digest);
        if(binding.slot==='indexed_cases')indexes.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
      }
      if(slots.size!==2){category='required_source_missing';throw new Error(category);}
      const manualDigests=run.sources.flatMap((binding:any)=>binding.role==='expected'&&typeof binding.external==='string'&&binding.external.startsWith('manual:')&&typeof binding.reference==='string'?(/^src:([a-f0-9]{64})(?:\/|$)/.exec(binding.reference)?.[1]??[]):[]);
      if(!manualDigests.includes(sha256(manual))){category='pairing_manual_binding_mismatch';throw new Error(category);}
      const manuals:Uint8Array[]=[...new Set<string>(manualDigests)].map(digest=>sources.get(digest)!);

      // A quote can name another stored original. Export it automatically before treating its bytes as missing.
      for(const draft of locatedDrafts(submission))for(const expected of draft.data.expected??[]) {
        const digest=typeof expected.quote?.reference==='string'?/^src:([a-f0-9]{64})(?:\/|$)/.exec(expected.quote.reference)?.[1]:undefined;
        if(digest&&!sources.has(digest)&&sha256(manual)!==digest) {
          try{await obtain(digest,true);}catch{requests.push({draft:draft.draft,category:'design_gap',reason:MISSING,missing_fact:'quoted_source_original',next_action:'repair_original_export_then_rerun',owner:'Claude'});}
        }
      }
      indexes.push(...extraIndexes.map(index=>index.view));
      if(indexes.some(v=>!object(v)||!object(v.build)||v.build.root!==run.root)){category='index_root_mismatch';throw new Error(category);}
      category='comparison_unavailable';
      const inputs={commandTreeXml:xml,commandCatalog,manual:manuals,sources,run,fixField:config.fix_field};
      let comparison=computeComparison(gold,submission,result,inputs);
      category='index_view_schema_or_identity_defect';
      let duplicates=recountDuplicates(indexes,submission,xml,result);
      requests.push(...evidenceQuestions(comparison));
      const hubOutputMissing=!validRounds(result);
      for(const d of duplicates.details)if(d.gap)requests.push({draft:d.draft,category:'design_gap',reason:d.reason??MISSING,missing_fact:d.gap.fact,next_action:d.gap.action,owner:d.gap.owner});
      if(duplicates.skipped>0)requests.push({category:'design_gap',reason:INTEGRITY,missing_fact:'unread_indexed_documents',next_action:'retry_source_sync_and_export_complete_index',owner:'Claude'});
      const passed=gates(comparison),ok=Object.values(passed).every(Boolean)&&duplicates.passed&&requests.length===0&&!hubOutputMissing;
      totals.completed++;if(!ok)totals.failed++;if(!ok&&requests.length===0)totals.defects++;
      if(passed.commands)totals.command_gate_pass++;if(passed.quotes)totals.quote_gate_pass++;if(passed.origins)totals.origin_gate_pass++;if(duplicates.passed)totals.duplicate_gate_pass++;
      totals.known_step_rule_items+=comparison.parameters!.domains.items.filter(i=>i.differenceCategories.includes('negative_step_rule')).length;
      totals.known_simplified_match_items+=comparison.parameters!.domains.items.filter(i=>i.differenceCategories.includes('simplified_refutation_match')).length;
      totals.design_gaps+=requests.length;
      totals.expected_branch_affected+=duplicates.expectedBranchAffected;
      totals.drafts+=locatedDrafts(submission).length;
      const params=comparison.parameters!;
      totals.commands+=Object.values(params.domains.counts).reduce((n,v)=>n+v,0);
      for(const verdict of VERDICT.slice(0,3)){totals[`domain_${verdict}`]+=params.domains.counts[verdict];totals[`quote_${verdict}`]+=comparison.quoteOracle.counts[verdict];}
      totals.paraphrased+=comparison.quoteOracle.paraphrased;totals.expected_verbatim+=comparison.quoteOracle.expectedVerbatim;totals.necessary_only+=comparison.quoteOracle.necessaryOnly;
      totals.parameter_same+=params.same;totals.parameter_different+=params.different;totals.parameter_absent+=params.absent;
      for(const [target,counts] of Object.entries(comparison.quoteOracle.targets))for(const [verdict,count] of Object.entries(counts)){const key=`quote_${target}_${verdict}`;totals[key]=(totals[key]??0)+count;}
      totals.head_draft+=comparison.headOverlap.draftHeads;totals.head_doc+=comparison.headOverlap.docHeads;totals.head_shared+=comparison.headOverlap.shared;
      totals.pair_draft+=params.draftPairs;totals.pair_doc+=params.docPairs;totals.pair_shared+=params.shared;
      const buckets=object(result.partitions)?Object.values(result.partitions).flatMap(v=>Array.isArray(v)?v:[]):[],requirements=Array.isArray(run.requirements)?run.requirements:[];
      const satisfied=requirements.filter((r:any)=>buckets.length>0&&buckets.every(b=>(b.requirements??[]).some((v:any)=>v.requirement===r.key&&v.status===REQUIREMENT_STATUS[0]))).length;
      const rounds=validRounds(result)?`${result.rounds.used}/${result.rounds.max}`:'输出缺失';
      lines.push(`配对 ${ordinal}/${config.pairings.length}：运行 ${seenRuns}；提交 ${selected.submissions.length}；受理 ${selected.submissions.filter((s:any)=>s.acceptance==='accepted').length}；修复轮 ${rounds}；要求项 ${satisfied}/${requirements.length}；任务包 ${run.pack}；摘要 ${run.pack_digest}；输入摘要 ${[sha256(commandBytes),sha256(manual),sha256(mapBytes),...extraIndexes.map(index=>sha256(index.bytes)),...(declarationBytes?[sha256(declarationBytes)]:[]),...sources.keys()].join(' ')}；${ok?'通过':'不通过'}`);

      writePrivateJson(join(dir,'details.json'),{pair:ordinal,category:ok?'passed':requests.length?'design_gap':'comparison_defect',positions:[...comparisonDetails(comparison),...(hubOutputMissing?[{category:'hub_output_missing'}]:[])],duplicates:duplicates.details});
    }catch{
      const definite=['root_defect_mismatch','source_binding_invalid','index_root_mismatch','submission_identity_mismatch','export_integrity_mismatch','index_view_schema_or_identity_defect','invalid_run'].includes(category);
      if(definite)totals.defects++;
      const inputMismatch=category==='pairing_manual_binding_mismatch';
      if(!definite&&!inputMismatch&&!requests.length)requests.push({category:'design_gap',reason:MISSING,missing_fact:category,next_action:category==='no_defect_to_case_run'||category==='client_work_incomplete'?'rerun_pairing_with_explicit_retries':'repair_inputs_or_source_interface_then_rerun',owner:'Claude'});
      totals.design_gaps+=requests.length;totals.failed++;
      lines.push(`配对 ${ordinal}/${config.pairings.length}：运行 ${seenRuns}；不通过；${definite?'确定缺陷':inputMismatch?'输入不匹配':labelOf('reason',MISSING)} ${category}`);
      writePrivateJson(join(dir,'details.json'),{pair:ordinal,category:definite?'confirmed_defect':inputMismatch?'input_mismatch':'design_gap',finding:category});
    }finally{
      if(requests.length){writePrivateJson(join(dir,'followup.json'),requests);lines[pairLine]+=`；补证清单已写入配对目录 ${requests.length} 项，待集成者 Claude 执行；流程未完成`;}
      writePrivateJson(join(dir,'actions.json'),actions);lockEvidence(dir);
    }
  }
  const ratio=(a:number,b:number)=>b?`${(100*a/b).toFixed(1)}%`:'集合为空';
  lines.push(`汇总：配对 ${totals.pairs}；已处理 ${totals.completed}；待补证 ${totals.design_gaps}；确定缺陷 ${totals.defects}；不通过 ${totals.failed}；草稿 ${totals.drafts}；命令 ${totals.commands}；自动补证动作 ${totals.recovery_actions}`);
  lines.push(`命令头双向重叠 ${ratio(totals.head_shared,totals.head_draft)}/${ratio(totals.head_shared,totals.head_doc)}；命令参数组合双向重叠 ${ratio(totals.pair_shared,totals.pair_draft)}/${ratio(totals.pair_shared,totals.pair_doc)}（只报告）`);
  lines.push(`取值域：支持 ${totals.domain_support}；反驳 ${totals.domain_refute}；暂态待补证 ${totals.domain_unknown}；引文：支持 ${totals.quote_support}；反驳 ${totals.quote_refute}；暂态待补证 ${totals.quote_unknown}；改写 ${totals.paraphrased}`);
  lines.push(`参数组合累计：相同 ${totals.parameter_same}；同头异参 ${totals.parameter_different}；文档无命令头 ${totals.parameter_absent}；期望文字逐字 ${totals.expected_verbatim}；仅必要条件 ${totals.necessary_only}`);
  for(const target of ['fix','defect_other','manual','other','unknown_defect_field','unknown_target'])lines.push(`引文来源累计 ${target}：支持 ${totals[`quote_${target}_support`]??0}；反驳 ${totals[`quote_${target}_refute`]??0}；暂态待补证 ${totals[`quote_${target}_unknown`]??0}`);
  lines.push(`命令与参数：${totals.command_gate_pass===totals.pairs?'通过':'不通过'}；通过配对 ${totals.command_gate_pass}/${totals.pairs}；逐步判差异条目 ${totals.known_step_rule_items}；简化匹配差异条目 ${totals.known_simplified_match_items}（默认非零退出）`);
  lines.push(`引文：${totals.quote_gate_pass===totals.pairs?'通过':'不通过'}；通过配对 ${totals.quote_gate_pass}/${totals.pairs}`);
  lines.push(`引文来源：${totals.origin_gate_pass===totals.pairs?'通过':'不通过'}；通过配对 ${totals.origin_gate_pass}/${totals.pairs}`);
  lines.push(`查重：${totals.duplicate_gate_pass===totals.pairs?'通过':'不通过'}；通过配对 ${totals.duplicate_gate_pass}/${totals.pairs}`);
  lines.push('输入边界：用例的命令归属取自 Hub 导出的 index-view@1；本批独立重算查重，原件到命令归属由回归范围用例验收另行核验');
  lines.push(`期望结果相同分支：没法重算；影响草稿 ${totals.expected_branch_affected}；索引没有期望文字，包只比标题；包待修项 requirements.json:70`);
  const code=totals.completed===totals.pairs&&totals.failed===0&&totals.design_gaps===0&&totals.defects===0?0:1;
  lines.push(`批跑：${code===0?'通过':'不通过（存在差异或补证未完成）'}`);writePrivateJson(join(out,'summary.json'),totals);
  return {code,text:lines.join('\n'),totals};
}
export type ProcessRunner=(args:readonly string[],env:NodeJS.ProcessEnv)=>{status:number|null;stdout:string;stderr:string};
/** Only this adapter can invoke real clients; tests inject both the process runner and MCP calls. */
export function createBatchDeps(options:BatchOptions,processRunner?:ProcessRunner,tools:typeof callTools=callTools):BatchDeps {
  const env={...process.env,HUB_REAL_TOKEN:options.token,CIRCLE_HUB_TOKEN:options.token};
  const run=processRunner??((args,environment)=>{
    const child=spawnSync(process.execPath,[...args],{cwd:ROOT,env:environment,encoding:'utf8',maxBuffer:128*1024*1024,stdio:['ignore','pipe','pipe']});
    return {status:child.status,stdout:child.stdout??'',stderr:child.stderr??''};
  });
  let activeDir:string|undefined,sequence=0;
  const captured=(args:string[],dir:string,label:string)=>{
    const output=run(args,env),base=join(outsideGit(dir),`process-${++sequence}-${label}`);
    writeFileSync(base+'.stdout.txt',output.stdout,{mode:0o600,flag:'wx'});
    writeFileSync(base+'.stderr.txt',output.stderr,{mode:0o600,flag:'wx'});
    return output;
  };
  const cli=(args:string[],dir=activeDir)=>{
    if(!dir)throw new Error('no pairing evidence directory');
    const output=captured(['bin/circle-hub',...args],dir,args[0]==='run'?'run-show':args[1]==='list'?'admin-preflight':'original-export');
    if(output.status!==0)throw new Error('hub command failed');return output.stdout;
  };
  return {assertAdmin:async(dir)=>{cli(['original','list','--limit','1','--external','gold-preflight:'],dir);},now:()=>new Date(),
    review:async(args,out)=>{activeDir=out;const child=captured(['scripts/real/review-circle.ts',...args],out,'review-circle');return {complete:child.status===0,calls:readFileSync(join(out,'pair.calls.jsonl'),'utf8')};},
    show:async(run)=>JSON.parse(cli(['run','show',run,'--json'])),
    submission:async(record)=>{const [reply]=await tools({url:options.url??'http://127.0.0.1:7420/mcp',token:options.token,session:'gold-d2c'},[{tool:'get_nodes',args:{reference:`rec:${record}`}}]);if(reply.isError||!object(reply.structured)||!object(reply.structured.content)||typeof reply.structured.content.text!=='string')throw new Error('submission unavailable');return JSON.parse(reply.structured.content.text);},
    exportOriginal:async(sha,path)=>{cli(['original','export',sha,'--out',path],dirname(path));},
  };
}
export async function main(argv=process.argv.slice(2),injected?:BatchDeps):Promise<number>{
  const value=(name:string)=>{const i=argv.indexOf('--'+name);return i<0?undefined:argv[i+1];};
  const endpointArgs:string[]=[],allowed=new Set(['--endpoint-from','--circle-dir','--env-file','--provider','--model','--section','--hub-url','--circle-cli','--timeout-ms']);
  for(let i=0;i<argv.length;i++){if(['--pairings','--out','--retries'].includes(argv[i])){if(!argv[i+1]||argv[i+1].startsWith('--')){process.stderr.write('用法参数：不通过\n');return 2;}i++;continue;}if(!allowed.has(argv[i])||!argv[i+1]||argv[i+1].startsWith('--')){process.stderr.write('用法参数：不通过\n');return 2;}endpointArgs.push(argv[i],argv[++i]);}
  if(!value('pairings')||!value('out')||(!injected&&!process.env.HUB_REAL_TOKEN)){process.stderr.write('用法：--pairings <清单> --out <Git 外空目录>；令牌来自 HUB_REAL_TOKEN\n');return 2;}
  const retries=value('retries')===undefined?0:Number(value('retries'));
  if(!Number.isInteger(retries)||retries<0||retries>10){process.stderr.write('用法参数：--retries 要给出 0 到 10 的整数\n');return 2;}
  let inputField='--pairings';
  let config:Pairings;try{config=validatePairings(JSON.parse(readFileSync(outsideGit(value('pairings')!),'utf8')));inputField='--out';const target=outsideGit(value('out')!);if(existsSync(target)&&(!lstatSync(target).isDirectory()||readdirSync(target).length!==0))throw new Error('invalid output');}catch{process.stderr.write(`输入不通过：${inputField}\n`);return 2;}
  if(!injected){
    const mode=value('endpoint-from');
    if(mode!==undefined?(mode!=='circle'||['env-file','provider','section'].some(k=>value(k)!==undefined)):(!value('env-file')||!['qwen','glm'].includes(value('provider')??'')||!value('model'))){process.stderr.write('端点参数：不通过\n');return 2;}
  }
  const options={out:value('out')!,endpointArgs,retries,token:injected?'synthetic':process.env.HUB_REAL_TOKEN!,url:value('hub-url')};
  try{const report=await runBatch(config,options,injected??createBatchDeps(options));process.stdout.write(report.text+'\n');return report.code;}catch{process.stderr.write('批跑执行：不通过（执行未完成）\n');return 1;}
}
if(import.meta.main)process.exitCode=await main();
