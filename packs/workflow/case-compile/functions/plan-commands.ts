// Device CLI parameters are identified by the frozen runtime contract/profile roles. Only whole grammar parses
// over the Hub-supplied locked catalog produce identities; source case declarations are a separate constraint.
import {compileGrammar,commandIdentity,parseCommandState,commandTokens,type CommandDefinition} from './generated/skills/command-tools/command-check/grammar.ts';
import {isRecord} from './text.ts';
import {bindArguments} from './binding.ts';
import {refusedAccess,runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import {runtimeBlocks} from './block-runtime.ts';
import type {RuntimeProfile} from './profile.ts';
import type {PlanSlots} from './slots.ts';
import {identityOf,identityKey} from './typed-contract.ts';
import {readCommandPolicy,pathSegments,type CommandPolicy} from './generated/skills/command-tools/command-check/command-policy.ts';
import {readValueDomainClaims,valueDomainRefusals,TEXT_PARAMETER_TYPES,type ValueDomainClaim} from './generated/skills/command-tools/command-check/value-domain.ts';
import {clip} from './text.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {CatalogEntry} from '../../../../contracts/src/tables.ts';
import type {CommandParseStatus,Verdict} from '../../../../contracts/generated/vocabulary.ts';
type CommandVerdict = Extract<Verdict, 'unknown' | 'refute'>;
export interface CommandCatalog {policy?:unknown;authority_entries?:CatalogEntry[];root:string;complete:boolean;entries:CatalogEntry[];covered_lines?:string[];value_domains?:unknown[]}
export interface CommandProblem {document:string;pointer:string;message:string;verdict:CommandVerdict}
/** Device CLI values of the plan; `answers` are the indexes of confirmation answer steps, which are dialogue, not commands. */
export function deviceCommandLines(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,answers:ReadonlySet<number>=new Set()):Array<{line:string;pointer:string;object:string;method:string}>{
 const lines:Array<{line:string;pointer:string;object:string;method:string}>=[];
 for(const [index,step]of slots.steps.entries()){if(answers.has(index))continue;const entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);if(!entry||!allowed)continue;for(const value of bindArguments(entry,step,`/steps/${index}`).values)if(allowed.parameters[value.name]==='device_cli'&&typeof value.value==='string')lines.push({line:value.value,pointer:value.pointer,object:step.object,method:step.method});}
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
/**
 * The access level the locked tree declares for the parsed command against the prompt its method sends at: a refusal only where
 * the runner contract declares, with evidence, that this method's prompt does not accept commands of that level
 * (RefusedAccess). The level is read from the signature the identity names; a signature without a level, a method without a
 * declared refusal, or a level the contract does not list is not checked, and nothing is read from a method's name. The
 * message names the methods of the same object that send device commands and carry no such refusal.
 */
export function accessRefusal(contract:RuntimeContract,profile:RuntimeProfile,catalog:CommandCatalog,identity:CommandIdentity,object:string,method:string):string|null{
 const refused=refusedAccess(contract,object,method);if(!refused.length)return null;
 const entry=catalog.entries.find(candidate=>isRecord(candidate)&&Array.isArray(candidate.words)&&'/commands/'+candidate.words.map(encodeURIComponent).join('/')===identity.path);
 const signature=entry?.signatures.find(candidate=>candidate.reference===identity.signature),level=signature?.access?.name;
 if(!level||!refused.includes(level))return null;
 const others=profile.allowed.filter(call=>call.object===object&&call.method!==method&&Object.values(call.parameters).some(role=>role==='device_cli')&&!refusedAccess(contract,object,call.method).includes(level)).map(call=>call.method);
 return `命令“${entry!.words.join(' ')}”在锁定命令树里的级别是 ${level}，方法 ${method} 下发时所在的提示符不接受这一级别的命令（运行器合约 refused_access），设备会以语法错误拒绝；${others.length?`这台设备上可以下发它的方法：${others.join('、')}`:'这台设备上没有声明可以下发它的方法，缺的是运行器合约的方法声明，由合约维护者补'}`;
}
/**
 * The method a device command line is sent with, against the methods the runner contract declares for that object's output
 * (runtime.block_model.output_methods, the methods the block form lowers every device step to). The reference compiler
 * lowers every device configuration and observation to its configuration method, so a flat plan follows the same
 * declaration: a device command line sent with a method the contract does not declare for that object is refused, naming
 * the declared methods the bed profile allows for device command lines there. A contract without that declaration for the
 * object, or a declared method, is not checked; nothing is read from a method's name.
 */
export function deviceMethodRefusal(contract:RuntimeContract,profile:RuntimeProfile,object:string,method:string):string|null{
 const blocks=runtimeBlocks(contract),outputs=blocks&&Array.isArray(blocks.output_methods)?blocks.output_methods.filter(isRecord):[];
 const declared=[...new Set(outputs.filter(row=>row.object===object&&typeof row.method==='string').map(row=>row.method as string))];
 if(!declared.length||declared.includes(method))return null;
 const usable=profile.allowed.filter(call=>call.object===object&&declared.includes(call.method)&&Object.values(call.parameters).some(role=>role==='device_cli')).map(call=>call.method);
 return `设备命令行要用运行器合约为 ${object} 声明的设备方法下发（runtime.block_model.output_methods），方法 ${method} 不在其中；照 InfoTest，设备上的配置和观察都经这些方法下发。${usable.length?`这台设备上可以用：${usable.join('、')}`:'环境配置没有放行这些方法里能下发设备命令行的，缺的是环境配置的放行，由维护者补'}`;
}
export function valueDomainMessages(identity:CommandIdentity,claims:readonly ValueDomainClaim[]):string[]{
 const command=identity.path.split('/').slice(2).map(decodeURIComponent).join(' ');
 const parameters=identity.parameters.map(parameter=>({name:parameter.name,text:parameter.parsed.kind==='text'&&TEXT_PARAMETER_TYPES.includes(parameter.type.catalog_type??'')?parameter.parsed.value:null}));
 return valueDomainRefusals(command,parameters,claims).map(refusal=>{
  const told=refusal.violations.slice(0,5).map(violation=>`${violation.message}（手册写：「${clip(violation.rule_quote,200)}」）`).join('；')+(refusal.violations.length>5?`；另有 ${refusal.violations.length-5} 条`:'');
  return `命令“${command}”的参数 ${refusal.parameter} 的取值“${clip(refusal.value,80)}”不符合手册对这个参数的说明。状态未确认，判断错误。原因还没查清，${told}。下一步由编写模型改成符合手册说明的取值；认为手册解读有误时，请管理员核对。证据是上述手册原句，决定者是模型`;
 });
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
 const catalog=raw as unknown as CommandCatalog;const claims=readValueDomainClaims(catalog.value_domains);const definitions:CommandDefinition[]=[],candidates=new Set<CatalogEntry>();
 for(const entry of catalog.entries){if(!isRecord(entry)||!Array.isArray(entry.words)||entry.words.some(word=>typeof word!=='string'||!word)||!Array.isArray(entry.signatures)||typeof entry.reference!=='string')continue;const path='/commands/'+entry.words.map(encodeURIComponent).join('/'),ref='tree:'+catalog.root+path;
  if(entry.reference!==ref&&!(entry.reference.slice(0,ref.length+1)===ref+'@'&&entry.reference.slice(ref.length+1).length===64))continue;
  definitions.push({path,words:entry.words,signatures:entry.signatures});
  if(lines.some(({line})=>{const tokens=commandTokens(line);return tokens&&entry.words.every((word,index)=>tokens[index]?.value===word&&!tokens[index].quoted);}))candidates.add(entry as CatalogEntry);
 }
 const grammar=compileGrammar(definitions);
 for(const {line,pointer,object,method}of lines){if(catalog.covered_lines&&!catalog.covered_lines.includes(line)){note(pointer,'目录回执未覆盖这条完整计划命令；重新核验计划以取得锁定目录依据');continue;}const state=parseCommandState(grammar,line) as {status:CommandParseStatus;missing?:string},parsed=commandIdentity(grammar,line),identity=parsed?identityOf(parsed):null;
  const methodRefusal=deviceMethodRefusal(contract,profile,object,method);if(methodRefusal)note(pointer,methodRefusal,'refute');
  if(identity){byLine.set(line,identity);const refusal=methodRefusal?null:accessRefusal(contract,profile,catalog,identity,object,method);if(refusal)note(pointer,refusal,'refute');for(const message of valueDomainMessages(identity,claims))note(pointer,message,'refute');}else if(state.status==='parameters_unchecked'||state.status==='parsed')note(pointer,state.missing??'完整签名缺类型、原始声明或唯一身份；下一步由目录生产器补结构声明后重核');else note(pointer,'不是锁定 /commands 完整语法可解析的命令；逐词、参数类型和完整消费均须满足',catalog.complete?'refute':'unknown');
 }
 const identities=[...new Map([...byLine.values()].map(identity=>[identityKey(identity),identity])).values()];
 declarations(identities);
 return {identities,byLine,problems,catalog:{root:catalog.root,complete:catalog.complete,entries:[...candidates],...evidence,covered_lines:[...new Set(lines.map(value=>value.line))]},answers};
}
