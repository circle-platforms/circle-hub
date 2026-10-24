import type { Hub, Piece } from './hub.ts';
import type { Judge } from './judge.ts';
import { PACK_REF, GENERATED, defaultKind, readPiece, treeReference } from './pieces.ts';
import { inputDigest, topChoice, shouldDescend, NONE_OPTION, type JevChoiceQuestion } from './api.ts';
import { maskLiterals, thresholdOf } from './calibration.ts';
import { narrowCandidates, optionNames, type PlacementChild } from './placement.ts';
import { checkResponse, checkModel } from './validate.ts';
import { Refusal, readJsonFile, secureUrl, cut, need, record, sha, type LocalStore } from './local.ts';
interface Context { values: any; hub: Hub; judge: Judge|null; store: LocalStore; allowed: Set<string>; model:string; io:{cwd:string;stdout:(v:string)=>void;stderr:(v:string)=>void} }
const within=(path:string,under:string)=>under==='/'||path===under||path.startsWith(under+'/');
const segments=(path:string)=>path==='/'?[]:path.slice(1).split('/').map(decodeURIComponent);
class Tree {
  hub:Hub;root:string;cache=new Map<string,any>();pieces=new Map<string,Piece>();
  constructor(hub:Hub,root:string){this.hub=hub;this.root=root;}
  async node(path:string){if(!this.cache.has(path)){const nodes=await this.hub.nodes(this.root,[path],0);for(const node of nodes)this.cache.set(node.path,node);}const node=this.cache.get(path);need(node,'树中没有路径；从 Hub 重新读取路径后重跑');return node;}
  async piece(id:string,reference:string,allowed:Set<string>){let value=this.pieces.get(reference);if(!value){value=await readPiece(this.hub,id,reference,allowed);this.pieces.set(reference,value);}need(allowed.has(value.kind),'片段种类未选择加入；按本次外发策略重跑');return {...value,id};}
  async all(under:string){const nodes:any[]=[];const queue=[under];const seen=new Set<string>();while(queue.length){const path=queue.shift()!;if(seen.has(path))continue;seen.add(path);const node=await this.node(path);nodes.push(node);queue.push(...node.children.map((v:any)=>v.path));}return nodes;}
  async children(path:string,exclude?:string,literals:string[]=[]):Promise<PlacementChild[]>{const node=await this.node(path);const out:PlacementChild[]=[];for(const child of node.children){const target=await this.node(child.path);const entry=target.entries.find((e:any)=>e.entry!==exclude&&defaultKind(e.kind));let description:null|string=null;if(entry){const piece=await this.piece('description',entry.reference,new Set(GENERATED.axes.entry_kind.filter((v:any)=>defaultKind(v.code)).map((v:any)=>v.code)));description=cut(maskLiterals(piece.text.split('\n').find(line=>line.trim()!=='')?.trim()??'',literals),160);}out.push({name:child.name,path:child.path,description});}return out;}
}
function question(id:string,path:string,children:PlacementChild[]):{question:JevChoiceQuestion;options:Map<string,string>}{const options=optionNames(children);const criteria:Record<string,string|null>={};for(const [option,name]of options){const child=children.find(v=>v.name===name)!;criteria[option]=child.description===null?(option===name?null:cut(name,160)):cut((option===name?'':name+': ')+child.description,160);}criteria[NONE_OPTION]='None of these children fits, or the passage is about this node itself.';return {options,question:{type:'choice',instructions:`Classify the passage \`${id}\` under knowledge node ${path}. Choose a child or none.`,criteria}};}
type CalibrationTask={piece:Piece;path:string;expected:string;question:JevChoiceQuestion;options:Map<string,string>};
async function calibrationTasks(tree:Tree,under:string,limit:number,allowed:Set<string>):Promise<CalibrationTask[]>{
  const nodes=await tree.all(under);const rows=nodes.flatMap(node=>node.entries.filter((e:any)=>defaultKind(e.kind)&&node.path!=='/').map((entry:any)=>({node,entry}))).sort((a,b)=>a.entry.entry<b.entry.entry?-1:a.entry.entry>b.entry.entry?1:a.node.path<b.node.path?-1:1).slice(0,limit);
  const tasks:Array<{piece:Piece;path:string;expected:string;question:JevChoiceQuestion;options:Map<string,string>}>=[];
  for(const row of rows){const original=await tree.piece('sample',row.entry.reference,allowed);const parts=segments(row.node.path);const words=Array.isArray(row.entry.data?.words)?row.entry.data.words.filter((v:unknown)=>typeof v==='string'):[];const literals=[...parts,parts.join(' '),words.join(' '),...words];const text=maskLiterals(original.text,literals);
   for(let depth=0;depth<=parts.length;depth++){const path=depth===0?'/':'/'+row.node.path.slice(1).split('/').slice(0,depth).join('/');const children=await tree.children(path,row.entry.entry,literals);if(depth===parts.length&&!children.length)continue;const candidates=narrowCandidates(children,text);if(!candidates)continue;const id='q'+inputDigest({entry:row.entry.entry,path}).slice(0,40);const prepared=question(id,path,candidates);const expectedName=depth<parts.length?parts[depth]:null;const expected=expectedName===null?NONE_OPTION:[...prepared.options].find(([,name])=>name===expectedName)?.[0];if(!expected)continue;tasks.push({piece:{...original,id,text,sha256:sha(text),bytes:Buffer.byteLength(text)},path,expected,...prepared});}
  }
  return tasks;
}
export async function deriveCalibrationTasks(hub:Hub,root:string,under:string,limit=10000){return calibrationTasks(new Tree(hub,root),under,limit,new Set<string>(GENERATED.axes.entry_kind.filter((v:any)=>defaultKind(v.code)).map((v:any)=>v.code)));}
export async function calibrationState(store:LocalStore,model:string,hub:Hub){
 const byInput=new Map<string,any>();const records=new Map((await store.records('judgments.jsonl')).map(value=>[inputDigest(value),value]));const tasksByScope=new Map<string,Map<string,CalibrationTask>>();let discarded=0;
 for(const set of await store.records('calibration.jsonl')){
  if(set.model!==model||set.chain!=='placement.choice')continue;
  if(!Array.isArray(set.samples)||!Array.isArray(set.judgments)||set.samples.length!==set.judgments.length||typeof set.root!=='string'||!/^[a-f0-9]{64}$/.test(set.root)||typeof set.under!=='string'||!set.under.startsWith('/')){discarded+=Array.isArray(set.samples)?set.samples.length:1;continue;}
  const scope=JSON.stringify([set.root,set.under]);let tasks=tasksByScope.get(scope);if(!tasks){tasks=new Map((await deriveCalibrationTasks(hub,set.root,set.under)).map(task=>[task.piece.id,task]));tasksByScope.set(scope,tasks);}
  for(const [i,sample]of set.samples.entries()){
   const r=records.get(set.judgments[i]);const task=r?tasks.get(r.question_id):undefined;
   if(!r||!task||r.requested_model!==model||r.returned_model!==model||r.exact_model!==model||r.question_type!=='choice'||!Array.isArray(r.candidates)||!record(r.probabilities)||typeof r.input_digest!=='string'||!/^[a-f0-9]{64}$/.test(r.input_digest)||!record(r.answer)||r.answer.type!=='choice'){discarded++;continue;}
   const q=task.question;const request={model,state:{[task.piece.id]:task.piece.text},questions:{[task.piece.id]:q}};let top:ReturnType<typeof topChoice>;
   try{checkResponse(request,{model,answers:{[task.piece.id]:r.answer},usage:r.usage},{pinnedModel:model});top=topChoice(r.answer);}catch{discarded++;continue;}
   const input=inputDigest({piece:r.input_digest,node:task.path});
   if(r.instructions!==q.instructions||r.input_digest!==inputDigest(task.piece.text)||r.state_digest!==inputDigest(request.state)||inputDigest(r.candidates)!==inputDigest(Object.entries(q.criteria).map(([name,description])=>({name,description})))||inputDigest(r.probabilities)!==inputDigest(r.answer.probabilities)||!record(sample)||sample.input!==input||sample.expected!==task.expected||sample.chosen!==top.choice||sample.probability!==top.p){discarded++;continue;}
   byInput.set(input,{input,expected:task.expected,chosen:top.choice,probability:top.p});
  }
 }
 return {...thresholdOf([...byInput.values()]),total:byInput.size,discarded};
}
function limitOf(value:unknown){const number=value===undefined?200:Number(value);need(Number.isSafeInteger(number)&&number>0&&number<=10000,'--limit 必须是 1 到 10000 的整数；缩小这次任务后重跑');return number;}
async function upload(hub:Hub,value:unknown){const bytes=JSON.stringify(value);const result=await hub.call('upload_file',{file_path:Buffer.from(bytes).toString('base64'),media_type:'application/json',name:'client-contribution.json'});need(result.call_result==='ok'&&result.acceptance==='accepted'&&typeof result.reference==='string','Hub 没有受理上传；按回执修正输入后重跑');return result.reference;}
async function start(hub:Hub,manifest:unknown,product:string,build:string,key:string){const reference=await upload(hub,manifest);const result=await hub.call('start_run',{pack:PACK_REF,product,build,inputs:{subject:{reference}},client_key:key});need(result.call_result==='ok'&&record(result.run)&&typeof result.run.root==='string'&&/^[a-f0-9]{64}$/.test(result.run.pack_digest)&&typeof result.run.run==='string','运行没有锁定根；核对产品、构建和包分配后重跑');return result.run;}
export async function runWorkflow(action:string,c:Context):Promise<number>{
 const {values:v,hub,judge,store,allowed,model,io}=c;
 if(action==='lock'){need(v.product&&v.build,'lock 缺少产品或构建；补 --product 和 --build');const run=await start(hub,{items:[]},v.product,v.build,inputDigest({lock:true,product:v.product,build:v.build}));await store.write('lock.json',{run:run.run,root:run.root,pack:PACK_REF,pack_digest:run.pack_digest},true);io.stdout(`运行 ${run.run}；根 ${run.root}`);return 0;}
 if(action==='submit')return submit(c);
 need(v.root&&/^[a-f0-9]{64}$/.test(v.root)&&typeof v.under==='string'&&v.under.startsWith('/'),'缺少确切根或起点；补 --root 与 --under');const tree=new Tree(hub,v.root);await tree.node(v.under);const limit=action==='calibrate'?limitOf(v.limit):v.limit===undefined?Number.MAX_SAFE_INTEGER:limitOf(v.limit);
 if(action==='calibrate'){
  const tasks=await calibrationTasks(tree,v.under,limit,allowed);
  if(v['dry-run']){io.stdout(`校准预览：${tasks.length} 道题，最多 ${tasks.length} 次请求；未调用 Jev；所有者确认数量后去掉 --dry-run 重跑`);return 0;}
  const samples:any[]=[];const judgments:string[]=[];let failed=0;
  for(const task of tasks){const result=await judge!.ask({state:{[task.piece.id]:task.piece.text},questions:{[task.piece.id]:task.question},pieces:[task.piece],bindings:{[task.piece.id]:[task.piece.id]},action:'calibrate',node:task.path});const value=result.answers[task.piece.id];if(!value){if(!result.oversized.includes(task.piece.id))failed++;continue;}const top=topChoice(value.answer);samples.push({input:inputDigest({piece:value.input_digest,node:task.path}),expected:task.expected,chosen:top.choice,probability:top.p});judgments.push(inputDigest(value));}
  const set={chain:'placement.choice',model,root:v.root,under:v.under,kinds:GENERATED.axes.entry_kind.filter((k:any)=>defaultKind(k.code)).map((k:any)=>k.code),samples,judgments,excluded:[...judge!.oversized].map(([id,value])=>({id,...value}))};const digest=inputDigest(set);await store.write(`calibration/placement.choice@${model}/${digest}.json`,set);await store.append('calibration.jsonl',set);const state=await calibrationState(store,model,hub);io.stdout(`校准 Jev@${model}：样例 ${state.total}，阈值 ${state.threshold??'未达到'}；排除超预算 ${judge!.oversized.size} 题；不足时继续取更多已知挂法样例并重跑 calibrate，不产生提议`);for(const value of judge!.oversized.values())io.stdout(value.message);if(failed){for(const [id,message]of judge!.failures)io.stderr(id+'：'+message);io.stderr(`校准有 ${failed} 题未回答，超长 ${judge!.oversized.size} 题；具体原因和下一步见记录`);return 3;}return 0;
 }
 need((!!v.pieces)!=(!!v.from),'place 要在 --pieces 和 --from 中选一个；不能同时给');let rows:Array<{id:string;reference:string}>=[];
 if(v.pieces){const raw=await readJsonFile(v.pieces,io.cwd,store.guard);need(record(raw)&&Array.isArray(raw.pieces),'--pieces 文件须有 pieces 列表，逐项 id 和 tree: reference');rows=raw.pieces;}else{const nodes=await tree.all(v.from);rows=nodes.filter(node=>!within(node.path,v.under)).flatMap(node=>node.entries.filter((e:any)=>allowed.has(e.kind)).map((e:any)=>({id:'p_'+e.entry.slice(0,16),reference:e.reference})));}
 const pieces:Piece[]=[];for(const row of rows.slice(0,limit)){need(typeof row.id==='string'&&typeof row.reference==='string','归位片段缺 id 或 reference；回读后补齐');need(treeReference(row.reference).root===v.root,'片段引用的根和 --root 不同；从本次根重取片段引用后重跑 place');pieces.push(await tree.piece(row.id,row.reference,allowed));}
 if(v['dry-run']){io.stdout(`归位预览：${pieces.length} 个片段，逐层一道题，精确请求数依赖前一层回答；未调用 Jev；所有者确认片段数后去掉 --dry-run`);return 0;}
 const calibration=await calibrationState(store,model,hub);const outcomes:any[]=[];const proposals:any[]=[];let failed=0;
 for(const piece of pieces){let path=v.under;let probability:number|null=null;let supporting:string|null=null;let candidate:any=null;let reason='已到叶节点';let missing=false;let excluded=false;const judgments:string[]=[];let descended=0;
  for(let depth=0;depth<64;depth++){const children=await tree.children(path,treeReference(piece.reference).entry);if(!children.length)break;const narrowed=narrowCandidates(children,piece.text);if(!narrowed){reason='子节点超过 254 个，字面缩小后仍不能提问；下一步缩小起点后重跑 place';break;}const id='q'+inputDigest({piece:piece.sha256,path}).slice(0,40);const prepared=question(id,path!,narrowed);const statePiece={...piece,id};const result=await judge!.ask({state:{[id]:piece.text},questions:{[id]:prepared.question},pieces:[statePiece],bindings:{[id]:[id]},action:'place',node:path});const judgment=result.answers[id];if(!judgment){excluded=result.oversized.includes(id);missing=!excluded;if(missing)failed++;reason=judge!.oversized.get(id)?.message??judge!.failures.get(id)??'没有得到回答；稍后重跑，已有回答复用；本地超时不证明对方没处理，可能已计费';break;}judgments.push(inputDigest(judgment));const top=topChoice(judgment.answer);candidate={name:top.choice,p:top.p};
   if(calibration.threshold===null){reason='本确切版本没有合格校准；下一步运行 calibrate 并补足样例后重跑 place';break;}if(top.isNone){reason='选择 none，停在当前节点';break;}if(top.margin===0){reason='最高概率并列，停在当前节点';break;}if(!shouldDescend(judgment.answer,calibration.threshold)){reason='概率低于校准阈值，停在当前节点';break;}const name=prepared.options.get(top.choice);const child=narrowed.find(v=>v.name===name);need(child,'回答不对应已读子节点；重新读取后重跑');path=child.path;probability=top.p;supporting=inputDigest(judgment);descended++;if(depth===63)reason='到达 64 层读取上限；用当前节点作起点继续 place';
  }
  const outcome={reference:piece.reference,path:descended?path:null,stopped_at:path,reason,p:probability,threshold:calibration.threshold,model,judgments,candidate,unanswered:missing,excluded};outcomes.push(outcome);
  if(descended&&!missing&&!excluded){const code=GENERATED.axes.document_output_kind.find((v:any)=>v.code==='placement_proposal')!.code;proposals.push({id:'p_'+treeReference(piece.reference).entry.slice(0,16),code,text:proposalText(path,model,probability!,calibration),data:{root:v.root,path,source:{reference:piece.reference,quote:cut(piece.text.split('\n')[0]!,200)}},supporting_judgment:supporting,judgments});}
 }
 await store.write('placement.json',{model,root:v.root,items:outcomes},true);await store.write('proposals.json',{model,root:v.root,calibration:{threshold:calibration.threshold,total:calibration.total},items:proposals},true);io.stdout(`归类判断：Jev@${model}；候选 ${outcomes.length}，提议 ${proposals.length}；只影响位置；停法和补取动作见 placement.json`);return failed?3:0;
}
function proposalText(path:string,model:string,p:number,calibration:{threshold:number|null;total:number}){return `归位提议：放到 ${path}。归类判断：Jev@${model}，p=${p.toFixed(2)}，只影响位置（阈值 ${calibration.threshold}，校准样例 ${calibration.total} 个）`;}
export class ProposalRefusal extends Refusal {
 readonly reason:string;readonly item:string;readonly index:number;readonly judgment:string;
 constructor(reason:string,message:string,item:string,index:number,judgment:string){super(`条目 ${item}（索引 ${index}，判断 ${judgment}）：${message}`);this.name='ProposalRefusal';this.reason=reason;this.item=item;this.index=index;this.judgment=judgment;}
}
export async function verifyProposals(input:any,hub:Hub,store:LocalStore,skip:ReadonlySet<string>=new Set()){
 store.guard(input);
 need(record(input)&&Array.isArray(input.items)&&input.items.every((p:any)=>record(p)&&typeof p.id==='string'),'提议条目缺少标识；重跑 place');
 checkModel(input.model,false);secureUrl(hub.url.href,input.model);
 if(input.items.every((p:any)=>skip.has(p.id)))return [];const all=new Map((await store.records('judgments.jsonl')).map(value=>[inputDigest(value),value]));const calibration=await calibrationState(store,input.model,hub);
 const tree=new Tree(hub,input.root);const allowed=new Set<string>(GENERATED.axes.entry_kind.map((v:any)=>v.code));const used=new Map<string,any>();
 for(const [index,p]of input.items.entries()){
  if(skip.has(p.id))continue;const item=typeof p.id==='string'?p.id:'未提供';let witness=typeof p.supporting_judgment==='string'?p.supporting_judgment:'未提供';
  const ensure:(ok:unknown,reason:string,message:string)=>asserts ok=(ok,reason,message)=>{if(!ok)throw new ProposalRefusal(reason,message,item,index,witness);};
  try{
  ensure(calibration.threshold!==null,'calibration_missing','该 --out 里没有有效校准及判断记录；用 place 的 --out 运行 submit，或重新 calibrate 后 place');
  ensure(record(input.calibration),'calibration_snapshot_missing','缺少 place 的校准快照；用当前校准重跑 place');
  ensure(input.calibration.threshold===calibration.threshold&&input.calibration.total===calibration.total,'calibration_changed',`校准已变（阈值 ${input.calibration.threshold}→${calibration.threshold}，样例 ${input.calibration.total}→${calibration.total}）；用当前校准重跑 place`);
  ensure(record(p)&&record(p.data)&&record(p.data.source)&&Array.isArray(p.judgments)&&p.judgments.length>0,'judgment_missing','该 --out 里没有这些判断记录；用 place 的 --out 运行 submit');
  const source=treeReference(p.data.source.reference);ensure(source.root===input.root&&p.data.root===input.root&&p.id==='p_'+source.entry.slice(0,16),'identity_mismatch','提议身份或根不符；重跑 place');
  ensure(p.code===GENERATED.axes.document_output_kind.find((v:any)=>v.code==='placement_proposal')!.code,'kind_mismatch','提议种类不是归位提议；重跑 place');
  const piece=await tree.piece('source',p.data.source.reference,allowed);ensure(p.data.source.quote===cut(piece.text.split('\n')[0]!,200),'quote_mismatch','提议引文被修改；重跑 place');
  let path:string|null=null;let supporting:string|null=null;let probability:number|null=null;let stopped=false;
  for(const hash of p.judgments){witness=String(hash);const r=all.get(hash);ensure(r,'judgment_missing','该 --out 里没有这些判断记录；用 place 的 --out 运行 submit');ensure(r&&r.requested_model===input.model&&r.returned_model===input.model&&r.exact_model===input.model,'model_mismatch','判断模型与提议不一致；用原确切版本重跑 place');ensure(!stopped,'after_stop','停止后的判断不能下降；重跑 place');
   const prefix=`Classify the passage \`${r.question_id}\` under knowledge node `;const suffix='. Choose a child or none.';ensure(typeof r.instructions==='string'&&r.instructions.startsWith(prefix)&&r.instructions.endsWith(suffix),'question_mismatch','判断不是归位问题；重跑 place');const at=r.instructions.slice(prefix.length,-suffix.length);ensure(at.startsWith('/')&&(path===null||path===at),'descent_mismatch','判断链路径不连续；重跑 place');path=at;
   const id='q'+inputDigest({piece:piece.sha256,path}).slice(0,40);const narrowed=narrowCandidates(await tree.children(path!,source.entry),piece.text);ensure(narrowed,'node_unavailable','判断节点不能提问；重跑 place');const prepared=question(id,path!,narrowed);
   ensure(r.question_type==='choice'&&r.question_id===id&&r.input_digest===inputDigest(piece.text)&&r.state_digest===inputDigest({[id]:piece.text})&&inputDigest(r.candidates)===inputDigest(Object.entries(prepared.question.criteria).map(([name,description])=>({name,description})))&&r.instructions===prepared.question.instructions,'input_mismatch','判断输入或选项不符；回读树后重跑 place');
   const top=topChoice(r.answer);if(shouldDescend(r.answer,calibration.threshold!)){const name=prepared.options.get(top.choice);const child=narrowed.find(v=>v.name===name);ensure(child,'target_missing','判断缺目标子节点；重跑 place');path=child.path;supporting=hash;probability=top.p;}else stopped=true;used.set(hash,r);
  }
  ensure(supporting!==null&&probability!==null&&supporting===p.supporting_judgment&&path===p.data.path,'support_mismatch','提议目标或支持判断不符；重跑 place');ensure(p.text===proposalText(path!,input.model,probability!,calibration),'text_mismatch','提议模型或概率文字与已核记录不一致；重跑 place');
  }catch(error){if(error instanceof ProposalRefusal)throw error;if(error instanceof Refusal)throw new ProposalRefusal('tree_read',error.message,item,index,witness);throw error;}
 }
 return [...used.values()];
}
async function submit(c:Context):Promise<number>{const {values:v,hub,store,io}=c;need(v.proposals&&v.product&&v.build,'submit 缺少 --proposals、--product 或 --build；补齐后重跑');const input=await readJsonFile(v.proposals,io.cwd,store.guard);store.guard(input);need(record(input)&&Array.isArray(input.items)&&typeof input.model==='string','提议文件不完整；重跑 place');const skip=new Map<string,string>();for(const value of v.skip??[]){const at=value.indexOf('=');need(at>0&&value.slice(at+1).trim()!=='','--skip 须为条目=具体理由');skip.set(value.slice(0,at),value.slice(at+1));}
 need([...skip.keys()].every(id=>input.items.some((p:any)=>p.id===id)),'--skip 指向清单外条目；从回执照抄本批条目标识和理由后重跑');
 const judgments=await verifyProposals(input,hub,store,new Set(skip.keys()));
 const manifest={items:input.items.map((p:any,i:number)=>({id:p.id,title:`${i+1} ${p.data?.path??'已跳过'}`}))};const run=await start(hub,manifest,v.product,v.build,inputDigest({manifest,product:v.product,build:v.build}));need(input.items.every((p:any)=>skip.has(p.id)||p.data.root===run.root)&&input.root===run.root,`place 读取的根与这次锁定根不同；下一步用本次根 ${run.root} 重跑 place 和 submit`);
 const notes=await upload(hub,{judgments});
 const items=input.items.map((p:any)=>skip.has(p.id)?{item:p.id,handling:'skipped',reason:skip.get(p.id)}:{item:p.id,handling:'handled',slots:{contribution:[{code:p.code,text:p.text,data:p.data}]}});
 const result=await hub.call('submit_result',{run:run.run,model:`${input.model}（Circle 技能 jev，${GENERATED.id}@${run.pack_digest}）`,items,notes});
 await store.append('run-identities.jsonl',{run:run.run,pack:PACK_REF,pack_digest:run.pack_digest});const file='receipt-'+inputDigest(result)+'.json';await store.write(file,result);try{await store.write('receipt.json',result);}catch{/* Earlier receipt stays immutable; the digest-named receipt is this call's result. */}
 await store.append('receipts.jsonl',{file,run:run.run,result});for(const text of hub.lastText)io.stdout(text);io.stdout(`回执运行 ${run.run}；${file}`);for(const error of result.errors??[])io.stdout(JSON.stringify(error));if(result.acceptance!=='accepted'||(result.result?.contributions?.not_stored??[]).some((v:any)=>!skip.has(v.item))){io.stderr('有提议未入层；按回执点名条目重跑 place，或用 --skip 条目=理由 标为跳过后再交');return 3;}return 0;}
