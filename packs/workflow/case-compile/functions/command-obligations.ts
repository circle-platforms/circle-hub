// Definition identities count authored operations; fully parsed values still govern authorization and cleanup.
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import {compileGrammar,commandIdentity,commandLines,commandTokens,type CommandDefinition} from './generated/skills/command-tools/command-check/grammar.ts';
import {isRecord} from './text.ts';
import {addressKey} from './manifest.ts';
import {readCommandPolicy,within,pathSegments,inverseLine,inverseLines,type CommandPolicy} from './generated/skills/command-tools/command-check/command-policy.ts';
import {identityOf} from './typed-contract.ts';
import {commandTemplate,isCommandTemplate,resolvedKey,resolvedLine,type ResolvedCommand} from './cell-commands.ts';
import {TEXT_PARAMETER_TYPES} from './generated/skills/command-tools/command-check/value-domain.ts';
import type {PlanSlots} from './slots.ts';
import type {AuthorityGap} from './typed-authority.ts';
import type {RunnerCleanup} from './runtime-contract.ts';
/** A configuration command the runner's own cleanup clears (decision 112), with the rule that covers it. */
export interface RunnerCovered {pointer:string;object:string;line:string;rule:number;prefix:string;clears?:string[];source_line:number|null}
/** The first rule whose prefix starts the sent line, as the runner tests it; null when no rule covers the line. */
export function runnerRule(cleanup:RunnerCleanup|undefined,object:string,line:string):{rule:number;prefix:string;clears?:string[];source_line:number|null}|null{
 if(!cleanup||!cleanup.objects.includes(object))return null;
 for(const [rule,row]of cleanup.rules.entries()){const prefix=row.prefixes.find(p=>line.startsWith(p));if(prefix!==undefined)return {rule,prefix,...(row.clears?{clears:row.clears}:{}),source_line:row.line};}
 return null;
}
/** Matches an unconsumed cleanup step that belongs to the runner's teardown rules (by sent-line prefix or declared clear action). */
function runnerCleanupAction(cleanup:RunnerCleanup|undefined,object:string,line:string):{rule:number;prefix:string;clears?:string[];source_line:number|null}|null{
 if(!line)return null;
 const byPrefix=runnerRule(cleanup,object,line);if(byPrefix)return byPrefix;
 if(!cleanup||!cleanup.objects.includes(object))return null;
 for(const [rule,row]of cleanup.rules.entries())if(row.clears?.includes(line))return {rule,prefix:row.prefixes[0],clears:row.clears,source_line:row.line};
 return null;
}
export const definitionKey=(identity:Pick<CommandIdentity,'tree_root'|'path'|'signature'>)=>JSON.stringify([identity.tree_root,identity.path,identity.signature]);
export interface Operation {line:string;pointer:string;object:string;cleanup:boolean;input_register?:string}
export interface UndoneConfiguration {object:string;configured:number;inverse:number;until?:number;literals:string[];direction_known:boolean}
export type CatalogCommandDefinition=CommandDefinition&{reference:string};
function definitions(raw:unknown):CatalogCommandDefinition[]{
 if(!isRecord(raw)||typeof raw.root!=='string'||!/^[a-f0-9]{64}$/.test(raw.root))return [];
 return (Array.isArray(raw.authority_entries)?raw.authority_entries:Array.isArray(raw.entries)?raw.entries:[]).flatMap(entry=>{
  if(!isRecord(entry)||!Array.isArray(entry.words)||entry.words.some(word=>typeof word!=='string')||!Array.isArray(entry.signatures)||typeof entry.reference!=='string')return [];
  const path='/commands/'+entry.words.map(encodeURIComponent).join('/'),ref='tree:'+raw.root+path;
  const [target,revision,...rest]=entry.reference.split('@');
  if(target!==ref||rest.length||revision!==undefined&&!/^[a-f0-9]{64}$/.test(revision))return [];
  return [{path,words:entry.words,signatures:entry.signatures,reference:entry.reference} as CatalogCommandDefinition];
 });
}
/** Frozen catalog declarations shared by obligation checks and disclosure-only precheck. */
export { definitions as commandDefinitions };
/**
 * The typed addresses of the author's own commands (decision 115, the reference implementation's author provenance of addresses):
 * every address parameter of each case-text command line the locked tree resolves, compared by address. An address the
 * author wrote stays when it is not on the environment and is disclosed; only an address the plan made up is refused.
 */
export function authoredAddresses(raw:unknown,sourceTexts:readonly string[]):Set<string>{
 const out=new Set<string>();
 if(!isRecord(raw)||typeof raw.root!=='string'||!sourceTexts.length)return out;
 const grammar=compileGrammar(definitions(raw));
 for(const text of sourceTexts)for(const line of commandLines(text)){const identity=identityOf(commandIdentity(grammar,line.text));if(!identity)continue;for(const p of identity.parameters)if(p.parsed.kind==='address'&&(p.parsed.value.kind==='ipv4'||p.parsed.value.kind==='ipv6')){const key=addressKey(String(p.parsed.value.value));if(key)out.add(key);}}
 return out;
}
/**
 * The command a line of the author names without writing its arguments out: the longest command of the locked tree whose words
 * are the line's leading unquoted tokens, when nothing follows them or what follows is a description, not a CLI literal. The
 * reference engine reads the author's procedure this way (InfoTest mechanical_case_gate.py author_procedure_coverage: its
 * resolver answers `hit` on the longest head whatever the arguments, and an occurrence whose first argument is a description is
 * counted on the head alone, a description being a token that is not ASCII). A bare head is counted the same way here; the
 * reference engine holds it to an occurrence written out in the adapted steps. An occurrence with a literal first argument that
 * does not parse as a whole stays uncounted: the reference engine also compares that argument, which this port does not.
 */
export function namedCommand(grammar:ReturnType<typeof compileGrammar>,text:string):{path:string;words:string}|null{
 const tokens=commandTokens(text);if(!tokens?.length)return null;
 let current=grammar.root,found:{path:string;at:number}|null=null;
 for(let at=0;at<tokens.length;at++){if(tokens[at].quoted)break;const next=current.children.get(tokens[at].value);if(!next)break;current=next;if(current.path!==null)found={path:current.path,at};}
 if(!found)return null;
 const first=tokens[found.at+1];
 if(first!==undefined&&[...first.value].every(c=>c.charCodeAt(0)<128))return null;
 return {path:found.path,words:tokens.slice(0,found.at+1).map(token=>token.value).join(' ')};
}
export function commandObligations(operations:readonly Operation[],slots:PlanSlots,raw:unknown,sourceTexts:readonly string[],runner?:RunnerCleanup,covered?:RunnerCovered[],undoneConfigurations?:UndoneConfiguration[]):AuthorityGap[]{
 if(!operations.length&&!sourceTexts.length&&!slots.steps.some(step=>step.restore_for!==undefined))return [];
 const policy=readCommandPolicy(isRecord(raw)?raw.policy:undefined);
 const gaps:AuthorityGap[]=[];
 const note=(pointer:string,message:string,verdict:Extract<Verdict,'unknown'|'refute'>='refute',obligation?:Record<string,unknown>)=>gaps.push({document:'catalog',pointer,message,verdict,...(obligation?{obligation}:{})});
 if(!isRecord(raw)||typeof raw.root!=='string'||typeof raw.missing==='string'){note('/command_catalog',isRecord(raw)&&typeof raw.missing==='string'?raw.missing:'缺锁定目录，无法核对作者命令义务','unknown');return gaps;}
 const native=definitions(raw),grammar=compileGrammar(native);
 const parseOperation=(line:string,register?:string):ResolvedCommand|null=>register&&(line.includes('{}')||line.includes('{0}'))?commandTemplate(native,line,register):identityOf(commandIdentity(grammar,line));
 const parsed=operations.map(operation=>({...operation,identity:parseOperation(operation.line,operation.input_register)}));
 if(parsed.some(operation=>!operation.identity))return gaps; // Native parse outcomes already block; do not guess missing identities.
 const main=parsed.filter(operation=>!operation.cleanup&&operation.identity),cleanup=parsed.filter(operation=>operation.cleanup&&operation.identity);
 // Cleanup is an explicit suffix, including host/wait steps; it cannot hide an execution operation after cleanup.
 let inCleanup=false;slots.steps.forEach((step,index)=>{if(step.cleanup===true)inCleanup=true;else if(inCleanup)note('/steps/'+index,'清理段必须是末尾连续步骤，执行步骤不能放在清理段之后');});
 const authored=new Map<string,{identity:CommandIdentity;count:number}>(),planned=new Map<string,number>();
 const named=new Map<string,{words:string;count:number}>();
 for(const text of sourceTexts)for(const line of commandLines(text)){
  const identity=identityOf(commandIdentity(grammar,line.text));
  if(identity){const key=definitionKey(identity),row=authored.get(key)??{identity,count:0};row.count++;authored.set(key,row);continue;}
  const head=namedCommand(grammar,line.text);
  if(head){const row=named.get(head.path)??{words:head.words,count:0};row.count++;named.set(head.path,row);}
 }
 for(const operation of main){const key=definitionKey(operation.identity!);planned.set(key,(planned.get(key)??0)+1);}
 for(const [key,row]of authored){const actual=planned.get(key)??0;if(actual<row.count)note('/steps',`可以改参数，不可以删命令：${row.identity.path} 作者 ${row.count} 次、计划 ${actual} 次，尚缺 ${row.count-actual} 次`,'refute',{identity:{tree_root:row.identity.tree_root,path:row.identity.path,signature:row.identity.signature},required_count:row.count,planned_count:actual,missing_count:row.count-actual});}
 // A command the author named without its arguments is owed on the command alone: what the plan sends of that command, beyond
 // the occurrences the author wrote out in full, must reach the count. Another command of the same family does not serve it
 // (in run 20 a plan sent a neighbouring command in place of the one the author named, and nothing refused it).
 for(const [path,row]of named){
  const sent=main.filter(operation=>operation.identity!.path===path).length;
  const owed=[...authored.values()].filter(value=>value.identity.path===path).reduce((sum,value)=>sum+value.count,0);
  const landed=Math.max(0,sent-owed);
  if(landed<row.count)note('/steps',`可以改参数，不可以删命令：作者写了命令 ${row.words}（没有写出参数）${row.count} 次，计划里这条命令 ${landed} 次，尚缺 ${row.count-landed} 次；换成别的命令不算`,'refute',{identity:{tree_root:raw.root,path},required_count:row.count,planned_count:landed,missing_count:row.count-landed});
 }
 if(!policy){if(operations.length)note('/command_policy','缺锁定根的产品命令范围与逆操作声明；下一步：产品包作者声明 command-policy@1 后重新育苗并核验','unknown');return gaps;}
 const modifies=(identity:Pick<CommandIdentity,'path'>)=>!policy.read_only.some(prefix=>within(identity.path,prefix));
 const selected=[...new Set([...operations.map(operation=>operation.line),...sourceTexts.flatMap(text=>commandLines(text).map(line=>line.text))])];
 const inversesRead=new Set([...selected,...inverseLines(policy,selected)]);
 const actual=cleanup.filter(operation=>modifies(operation.identity!)).map(operation=>({...operation,restore:undefined as typeof slots.steps[number]|undefined}));
 for(const [index,step]of slots.steps.entries())if(step.restore_for!==undefined)actual.push({line:'',pointer:'/steps/'+index,object:step.object,cleanup:true,identity:null,restore:step});
 const ordinal=(pointer:string)=>Number(pointer.split('/')[2]);actual.sort((a,b)=>ordinal(a.pointer)-ordinal(b.pointer));
 // A signature whose enum alternatives the product declared as inverse pairs (on/off and the like): the inverse of a
 // value is the paired value of the SAME signature — decided on the locked tree's declared enum members, never by
 // matching free text. Multiple inverse positions or a non-unique target stay unknown; only an absent enum rule
 // falls back to the declared prefix rules.
 const alternativeInverses=(identity:ResolvedCommand,received:ResolvedCommand|undefined):{identities:ResolvedCommand[];ambiguous:boolean}=>{
  const pairs=policy.inverse_alternatives??[];
  if(!pairs.length)return {identities:[],ambiguous:false};
  // A union argument type (an address of either family, say) publishes one native argument list as several catalog
  // signatures under the same reference, so each supplied position is read across all of them: where none declares an
  // enum holding a declared pair there is no alternative, and a pair is used only where every one declares that enum.
  const signatures=native.filter(definition=>definition.path===identity.path).flatMap(definition=>definition.signatures).filter(signature=>signature.reference===identity.signature);
  if(!signatures.length)return {identities:[],ambiguous:true};
  const inverses=new Map<string,ResolvedCommand>();let unrepresentable=false;
  for(const parameter of identity.parameters){
   if(parameter.parsed.kind!=='text')continue;
   const value=parameter.parsed.value,declared=signatures.map(signature=>signature.params[parameter.position]);
   const pairIn=(param:(typeof declared)[number])=>param?.type==='enum'&&Array.isArray(param.values)?pairs.find(([a,b])=>(a===value||b===value)&&param.values!.includes(a)&&param.values!.includes(b)):undefined;
   if(!declared.some(pairIn))continue;
   const pair=pairIn(declared[0]);
   if(!pair||declared.some(param=>JSON.stringify(param)!==JSON.stringify(declared[0]))){unrepresentable=true;continue;}
   const swapped=pair[0]===value?pair[1]:pair[0];
   const supplied=received?.parameters.find(p=>p.position===parameter.position);
   const tokens=commandTokens(swapped);
   const quoted='\"'+swapped.replaceAll('\\','\\\\').replaceAll('\"','\\\"')+'\"';
   const raw=supplied?.parsed.kind==='text'&&supplied.parsed.value===swapped?supplied.raw:tokens?.length===1&&tokens[0].value===swapped?swapped:quoted;
   const words=identity.path.split('/').slice(2).map(decodeURIComponent);
   const line=[...words,...identity.parameters.map(other=>{if(other===parameter)return raw;const same=received?.parameters.find(p=>p.position===other.position&&JSON.stringify(p.parsed)===JSON.stringify(other.parsed));return same?.raw??other.raw;})].join(' ');
   const inverse=parseOperation(line,isCommandTemplate(identity)?identity.input_register:undefined);
   if(inverse&&inverse.path===identity.path&&inverse.signature===identity.signature)inverses.set(resolvedKey(inverse),inverse);else unrepresentable=true;
  }
  if(inverses.size||unrepresentable)return {identities:[...inverses.values()],ambiguous:unrepresentable||inverses.size>1};
  // Only complete sibling paths of the same parent can use the leaf form of a declared pair.
  const segments=identity.path.split('/'),leaf=decodeURIComponent(segments.at(-1)!);
  const pair=pairs.find(([a,b])=>a===leaf||b===leaf);
  if(!pair)return {identities:[],ambiguous:false};
  const sibling=pair[0]===leaf?pair[1]:pair[0];
  const siblingPath=segments.slice(0,-1).join('/')+'/'+encodeURIComponent(sibling);
  if(!native.some(definition=>definition.path===siblingPath))return {identities:[],ambiguous:false};
  const line=[...siblingPath.split('/').slice(2).map(decodeURIComponent),...identity.parameters.map(parameter=>parameter.raw)].join(' ');
  const inverse=parseOperation(line,isCommandTemplate(identity)?identity.input_register:undefined);
  return inverse&&inverse.path===siblingPath?{identities:[inverse],ambiguous:false}:{identities:[],ambiguous:true};
 };
type Problem={pointer:string;message:string;verdict:Extract<Verdict,'unknown'|'refute'>;obligation?:Record<string,unknown>};
 const sourceRule=(identity:Pick<ResolvedCommand,'path'>)=>{
  const matches=policy.inverse_rules.filter(rule=>within(identity.path,rule.source_prefix)).sort((a,b)=>pathSegments(b.source_prefix)!.length-pathSegments(a.source_prefix)!.length);
  return matches[0]&&!(matches[1]&&matches[0].source_prefix===matches[1].source_prefix)?matches[0]:null;
 };
 // Whether `received` is the declared inverse of the configured `operation` (null) or why not. The same rule decides a cleanup
 // step and an execution step that undoes an earlier one.
 const inverseProblem=(operation:typeof main[number],received:(typeof actual)[number]|undefined):Problem|null=>{
  const identity=operation.identity!;
  if(received?.restore){
   const step=received.restore,target=step.restore_target,configOrdinal=Number(operation.pointer.split('/')[2])+1;
   return step.restore_for!==configOrdinal||step.object!==operation.object||!target||target.tree_root!==identity.tree_root?{pointer:operation.pointer,message:'缺同设备、逆序且绑定该配置的捕获恢复守卫',verdict:'refute',obligation:{cleanup_for:operation.pointer,missing_count:1}}:null;
  }
  const alternatives=alternativeInverses(identity,received?.identity??undefined);
  if(alternatives.ambiguous)return {pointer:operation.pointer,message:'声明的枚举互逆不能在同一签名中得到唯一完整身份；下一步由产品包作者修正互逆声明或命令树后重核',verdict:'unknown'};
  const alternative=alternatives.identities[0];
  if(alternative!==undefined)return !received||received.object!==operation.object||resolvedKey(received.identity!)!==resolvedKey(alternative)?{pointer:operation.pointer,message:`配置命令 ${identity.path} 缺同设备、逆序的清理操作（声明的枚举互逆：${resolvedLine(alternative)}）`,verdict:'refute',obligation:{cleanup_for:operation.pointer,inverse:alternative,missing_count:1}}:null;
  const rule=sourceRule(identity);if(!rule)return {pointer:operation.pointer,message:`配置命令 ${identity.path} 缺唯一的产品逆操作规则；下一步由产品包作者补声明后重核`,verdict:'unknown'};
  const path='/'+[...pathSegments(rule.inverse_prefix)!,...pathSegments(identity.path)!.slice(pathSegments(rule.source_prefix)!.length)].join('/');
  // The catalog selection read the rule's line with the plan, so a path the catalog does not hold is one the locked tree does not have: no plan can send it.
  const line=inverseLine(policy,operation.line);
  if(line!==null&&inversesRead.has(line)&&!native.some(definition=>definition.path===path))return {pointer:operation.pointer,message:`配置命令 ${identity.path} 按产品规则的逆操作 ${path} 不在锁定树里，计划写不出这条清理。照 InfoTest：不猜逆操作，也不改用范围更大的清除；先换一种在锁定树里有逐对象逆操作的等价写法，没有这样的写法才照实报告这个缺口；下一步由产品包作者在 inverse_rules 声明这条命令的真实逆操作并重新育苗后重核`,verdict:'unknown'};
  if(!received||received.object!==operation.object||received.identity!.path!==path)return {pointer:operation.pointer,message:`配置命令 ${identity.path} 缺同设备、逆序的清理操作 ${path}（清理命令必须由锁定树完整解析）`,verdict:'refute',obligation:{cleanup_for:operation.pointer,inverse_path:path,missing_count:1}};
  const parameters=[...identity.parameters].sort((a,b)=>a.position-b.position);
  const counts=rule.leading_parameters!==undefined?[rule.leading_parameters]:[...new Set(native.filter(definition=>definition.path===path).flatMap(definition=>definition.signatures.flatMap(signature=>Array.from({length:Math.min(signature.params.length,parameters.length)+1},(_,count)=>count))))];
  const copied=parameters.map((parameter,position)=>{const proposed=received.identity!.parameters.find(value=>value.position===position);return proposed&&commandTokens(parameter.raw)?.[0]?.value===commandTokens(proposed.raw)?.[0]?.value?proposed.raw:parameter.raw;});
  const inverses=new Map<string,ResolvedCommand>();
  for(const count of counts){if(count>parameters.length)continue;const line=[...path.split('/').slice(2).map(decodeURIComponent),...copied.slice(0,count)].join(' ');const inverse=parseOperation(line,isCommandTemplate(identity)?identity.input_register:undefined);if(inverse&&inverse.path===path&&inverse.parameters.length===count)inverses.set(resolvedKey(inverse),inverse);if(inverses.size>1)break;}
  if(inverses.size>1){
   // Several leading-parameter counts parse (decision 115: the case author writes the teardown): the plan's own cleanup
   // stands when it is exactly one of them; otherwise the refusal lists every valid form.
   if([...inverses.values()].some(candidate=>resolvedKey(candidate)===resolvedKey(received.identity!)))return null;
   return {pointer:operation.pointer,message:`配置命令 ${identity.path} 在逆序位置的清理应是下面之一：${[...inverses.values()].map(resolvedLine).join('；')}`,verdict:'refute',obligation:{cleanup_for:operation.pointer,inverse_path:path,missing_count:1}};
  }
  if(inverses.size!==1)return {pointer:operation.pointer,message:`配置命令 ${identity.path} 的逆操作 ${path} 不能按锁定树完整解析；由产品包作者核对规则与命令树`,verdict:'refute'};
  const inverse=[...inverses.values()][0];
  return resolvedKey(received.identity!)!==resolvedKey(inverse)?{pointer:operation.pointer,message:`配置命令 ${identity.path} 在逆序位置的清理参数不等于声明的前导身份参数：${resolvedLine(inverse)}`,verdict:'refute',obligation:{cleanup_for:operation.pointer,inverse,missing_count:1}}:null;
 };
 // Net effect, as SyntheticReference tears down only what is alive at the end: an execution step that is exactly the declared inverse of
 // a still-live earlier one on the same device undoes it (delete then re-create), and neither needs cleanup. The latest live
 // match is undone; anything not exactly the declared inverse stays live and needs its own cleanup.
 const literalValues=(identity:ResolvedCommand)=>identity.parameters.flatMap(parameter=>{
  if(parameter.parsed.kind!=='text'||!TEXT_PARAMETER_TYPES.includes(parameter.type.catalog_type??''))return [];
  const tokens=commandTokens(parameter.raw);return tokens?.length===1?[tokens[0].value]:[];
 });
 const replay=(operations:typeof parsed,collect=false)=>{
  const live:typeof main=[],removed:Array<{proof:UndoneConfiguration;inverse:typeof main[number]}>=[];
  for(const operation of operations.filter(operation=>modifies(operation.identity!))){
   if(collect)for(const row of removed)if(row.proof.until===undefined&&row.proof.object===operation.object&&inverseProblem(operation,{...row.inverse,restore:undefined})===null)row.proof.until=ordinal(operation.pointer);
   let undone=-1;for(let k=live.length-1;k>=0;k--)if(live[k].object===operation.object&&inverseProblem(live[k],{...operation,restore:undefined})===null){undone=k;break;}
   if(undone>=0){
    const [configured]=live.splice(undone,1);
    if(collect&&!live.some(other=>other.object===operation.object&&inverseProblem(other,{...operation,restore:undefined})===null)){
     const inverseValues=new Set(literalValues(operation.identity!));
     const alternatives=alternativeInverses(configured.identity!,operation.identity!);
     const direction_known=!!sourceRule(configured.identity!)&&!policy.inverse_rules.some(rule=>within(configured.identity!.path,rule.inverse_prefix))&&!alternatives.ambiguous&&!alternatives.identities.length;
     removed.push({proof:{object:operation.object,configured:ordinal(configured.pointer),inverse:ordinal(operation.pointer),literals:literalValues(configured.identity!).filter(value=>inverseValues.has(value)),direction_known},inverse:operation});
    }
   }else live.push(operation);
  }
  if(collect)undoneConfigurations!.push(...removed.map(row=>row.proof));
  return live;
 };
 const configured=replay(main).reverse();
 if(undoneConfigurations)replay(parsed,true);
 // Reverse order binds within one device: a device does not undo another's state, so the order between devices is free
 // (the reference implementation's teardown check is not order-sensitive at all). One the runner's own cleanup covers (every
 // sent line against the runner's prefix rules, first hit) needs none, and its explicit inverse is accepted wherever it
 // stands on that device, the runner tearing down whatever is left anyway; the case then undid it itself. Each other live
 // configuration, latest first, takes the device's next remaining cleanup step, which must be its declared inverse.
 const objects=[...new Set([...configured,...actual].sort((a,b)=>ordinal(a.pointer)-ordinal(b.pointer)).map(operation=>operation.object))];
 for(const object of objects){
  const own=actual.filter(step=>step.object===object),mine=configured.filter(operation=>operation.object===object);
  const taken=new Set<number>(),ordered:typeof mine=[],runnerOwned:RunnerCovered[]=[];
  for(const operation of mine){
   const rule=runnerRule(runner,operation.object,operation.line);
   if(!rule){ordered.push(operation);continue;}
   const k=own.findIndex((step,index)=>!taken.has(index)&&inverseProblem(operation,step)===null);
   if(k>=0)taken.add(k);else runnerOwned.push({pointer:operation.pointer,object:operation.object,line:operation.line,...rule});
  }
  const rest:typeof own=[];
  for(const step of own.filter((_,index)=>!taken.has(index))){
   const owned=runnerCleanupAction(runner,step.object,step.line);
   if(owned&&!ordered.some(operation=>inverseProblem(operation,step)===null)){
    const clearsText=owned.clears?.length?`，清理命令 ${owned.clears.map(c=>`“${c}”`).join('、')}`:'';
    const tailText=runner!.order?.tail.some(t=>t===step.line||owned.clears?.includes(t))?'，收尾阶段末尾执行':'';
    note(step.pointer,`清理段中的“${step.line}”不能放在 cleanup:true：这一步由执行器在收尾时做（规则 ${owned.rule+1}${owned.source_line!==null?`，${runner!.source} 第 ${owned.source_line} 行`:''}，前缀“${owned.prefix}”${clearsText}${tailText}），若用例过程本身需要执行则写在主步骤 main 中，cleanup:true 中删掉这步`);
    continue;
   }
   rest.push(step);
  }
  let next=0;
  for(const operation of ordered){
   if(next<rest.length&&inverseProblem(operation,rest[next])===null){next++;continue;}
   const problem=inverseProblem(operation,rest[next]);if(problem)note(problem.pointer,problem.message,problem.verdict,problem.obligation);next++;
  }
  // A left-over step that is the declared inverse of a live configuration of the same device stands out of reverse order; only
  // one that undoes nothing still live there is without an executed command.
  for(const extra of rest.slice(next)){
   const undoes=ordered.find(operation=>inverseProblem(operation,extra)===null);
   note(extra.pointer,undoes?`清理步骤是第 ${ordinal(undoes.pointer)+1} 步配置“${undoes.line}”的逆操作，但不在同一设备的逆序位置：同一设备上后执行的配置先清理`:'清理段含没有对应执行命令的额外配置操作'+(extra.line?`：“${extra.line}”不是本设备任何配置的声明逆操作`:'')+(runnerOwned.length?`；本设备 ${runnerOwned.length} 条配置由运行器清理收尾，不用写清理，删掉这步`:''));
  }
  covered?.push(...runnerOwned);
 }
 return gaps;
}
