// Device CLI parameters are identified by the frozen runtime contract/profile roles. Only whole grammar parses
// over the Hub-supplied locked catalog produce identities; source case declarations are a separate constraint.
import {compileGrammar,commandIdentity,parseCommandState,commandTokens,type CommandDefinition} from './generated/command-grammar.ts';
import {isRecord} from './text.ts';
import {bindArguments} from './binding.ts';
import {runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import type {RuntimeProfile} from './profile.ts';
import type {PlanSlots} from './slots.ts';
import {identityOf,identityKey} from './typed-contract.ts';
import {readCommandPolicy,pathSegments,type CommandPolicy} from './command-policy.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {CatalogEntry} from '../../../../contracts/src/tables.ts';
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
type CommandVerdict = Extract<Verdict, 'unknown' | 'refute'>;
export interface CommandCatalog {policy?:unknown;authority_entries?:CatalogEntry[];root:string;complete:boolean;entries:CatalogEntry[];covered_lines?:string[]}
export interface CommandProblem {document:string;pointer:string;message:string;verdict:CommandVerdict}
/** Device CLI values of the plan; `answers` are the indexes of confirmation answer steps, which are dialogue, not commands. */
export function deviceCommandLines(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,answers:ReadonlySet<number>=new Set()):Array<{line:string;pointer:string}>{
 const lines:Array<{line:string;pointer:string}>=[];
 for(const [index,step]of slots.steps.entries()){if(answers.has(index))continue;const entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);if(!entry||!allowed)continue;for(const value of bindArguments(entry,step,`/steps/${index}`).values)if(allowed.parameters[value.name]==='device_cli'&&typeof value.value==='string')lines.push({line:value.value,pointer:value.pointer});}
 return lines;
}
/** The product's declared confirmations (command-policy@1): a device command under a declared prefix must pass the declared
 * prompt as its runner prompt, and the very next step, on the same object and method and in the same section, must carry
 * exactly the declared answer as its only value. That next step is dialogue: it is not parsed against the catalog and has no
 * cleanup obligation. A declared command without its prompt and answer, a runner prompt on any other device command, and an
 * answer that does not follow its command are refused (a missing answer would leave the device waiting inside the dialogue). */
export function confirmationSteps(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,policy:CommandPolicy|null):{answers:Set<number>;problems:CommandProblem[]}{
 const answers=new Set<number>(),problems:CommandProblem[]=[],declared=policy?.confirmations??[];
 const refuse=(pointer:string,message:string)=>problems.push({document:'catalog',pointer,message,verdict:'refute'});
 const steps=slots.steps.map((step,index)=>{
  const entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);
  if(!entry||!allowed)return null;
  const values=bindArguments(entry,step,`/steps/${index}`).values;
  return {step,values,command:values.find(value=>allowed.parameters[value.name]==='device_cli'&&typeof value.value==='string'),prompt:values.find(value=>allowed.parameters[value.name]==='runner_option'&&entry.authority?.parameters[value.name]?.type.declaration.name==='runner_prompt')};
 });
 const confirmationOf=(line:string)=>{const tokens=commandTokens(line);return tokens?declared.find(row=>{const words=pathSegments(row.command_prefix)!.slice(1).map(decodeURIComponent);return words.length<=tokens.length&&words.every((word,i)=>tokens[i].value===word&&!tokens[i].quoted);}):undefined;};
 for(const [index,row]of steps.entries()){
  if(!row?.command||answers.has(index))continue;
  const confirmation=confirmationOf(String(row.command.value)),at=`/steps/${index}`;
  if(!confirmation){if(row.prompt)refuse(row.prompt.pointer,'运行器提示符参数只用于产品声明需要设备确认的命令；去掉该参数');continue;}
  const next=steps[index+1];
  const answered=next&&next.step.object===row.step.object&&next.step.method===row.step.method&&(next.step.cleanup===true)===(row.step.cleanup===true)&&next.values.length===1&&next.command===next.values[0]&&next.command.value===confirmation.answer;
  if(!row.prompt||row.prompt.value!==confirmation.prompt||!answered){refuse(at,`该命令需要设备确认：运行器提示符参数写 ${confirmation.prompt}，紧接着下一步在同一对象用同一方法只写应答 ${confirmation.answer}`);continue;}
  answers.add(index+1);
 }
 return {answers,problems};
}
export function planCommands(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,raw:unknown):{identities:CommandIdentity[];byLine:Map<string,CommandIdentity>;problems:CommandProblem[];catalog:CommandCatalog|null;answers:Set<number>}{
 const dialogue=confirmationSteps(contract,profile,slots,readCommandPolicy(isRecord(raw)?raw.policy:undefined));
 const lines=deviceCommandLines(contract,profile,slots,dialogue.answers),answers=dialogue.answers;
 const evidence=isRecord(raw)?{...(raw.policy!==undefined?{policy:raw.policy}:{}),...(Array.isArray(raw.authority_entries)?{authority_entries:raw.authority_entries}:Array.isArray(raw.entries)?{authority_entries:raw.entries}:{})}:{};
 const problems:CommandProblem[]=[...dialogue.problems],byLine=new Map<string,CommandIdentity>();const note=(pointer:string,message:string,verdict:CommandVerdict='unknown')=>problems.push({document:'catalog',pointer,message,verdict});
 const declarations=(identities:CommandIdentity[]):void=>{ if(slots.command_identities!==undefined){if(!Array.isArray(slots.command_identities)){note('/command_identities','模型提交的可选命令身份声明不是列表','refute');return;}const declared=slots.command_identities.map(identityOf);if(declared.some(identity=>identity===null))note('/command_identities','模型提交的命令身份结构或类型化值不一致','refute');else{const supplied=new Set(declared.map(identity=>identityKey(identity!))),actual=new Set(identities.map(identityKey));if(supplied.size!==actual.size||[...actual].some(key=>!supplied.has(key)))note('/command_identities','模型提交的命令身份不等于锁定目录对计划命令的完整解析','refute');}}};
 if(!lines.length){declarations([]);return {identities:[],byLine,problems,catalog:isRecord(raw)&&typeof raw.root==='string'&&typeof raw.complete==='boolean'?{root:raw.root,complete:raw.complete,entries:[],covered_lines:[],...evidence}:null,answers};}
 if(!isRecord(raw)||typeof raw.root!=='string'||!Array.isArray(raw.entries)||typeof raw.complete!=='boolean'){note('/command_catalog','缺 Hub 按锁定根提供的 commands 目录；不能用用例身份或模型自报身份代替完整解析');return {identities:[],byLine,problems,catalog:null,answers};}
 if(typeof raw.missing==='string'){note('/command_catalog',raw.missing);return {identities:[],byLine,problems,catalog:null,answers};}
 const catalog=raw as unknown as CommandCatalog;const definitions:CommandDefinition[]=[],candidates=new Set<CatalogEntry>();
 for(const entry of catalog.entries){if(!isRecord(entry)||!Array.isArray(entry.words)||entry.words.some(word=>typeof word!=='string'||!word)||!Array.isArray(entry.signatures)||typeof entry.reference!=='string')continue;const path='/commands/'+entry.words.map(encodeURIComponent).join('/'),ref='tree:'+catalog.root+path;
  if(entry.reference!==ref&&!(entry.reference.slice(0,ref.length+1)===ref+'@'&&entry.reference.slice(ref.length+1).length===64))continue;
  definitions.push({path,words:entry.words,signatures:entry.signatures});
  if(lines.some(({line})=>{const tokens=commandTokens(line);return tokens&&entry.words.every((word,index)=>tokens[index]?.value===word&&!tokens[index].quoted);}))candidates.add(entry as CatalogEntry);
 }
 const grammar=compileGrammar(definitions);
 for(const {line,pointer}of lines){if(catalog.covered_lines&&!catalog.covered_lines.includes(line)){note(pointer,'目录回执未覆盖这条完整计划命令；重新核验计划以取得锁定目录依据');continue;}const state=parseCommandState(grammar,line),parsed=commandIdentity(grammar,line),identity=parsed?identityOf(parsed):null;
  if(identity)byLine.set(line,identity);else if(state.status==='parameters_unchecked'||state.status==='parsed')note(pointer,state.missing??'完整签名缺类型、原始声明或唯一身份；下一步由目录生产器补结构声明后重核');else note(pointer,'不是锁定 /commands 完整语法可解析的命令；逐词、参数类型和完整消费均须满足',catalog.complete?'refute':'unknown');
 }
 const identities=[...new Map([...byLine.values()].map(identity=>[identityKey(identity),identity])).values()];
 declarations(identities);
 return {identities,byLine,problems,catalog:{root:catalog.root,complete:catalog.complete,entries:[...candidates],...evidence,covered_lines:[...new Set(lines.map(value=>value.line))]},answers};
}
