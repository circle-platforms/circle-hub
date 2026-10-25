// Definition identities count authored operations; fully parsed values still govern authorization and cleanup.
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import {compileGrammar,commandIdentity,commandLines,commandTokens,type CommandDefinition} from './generated/command-grammar.ts';
import {isRecord} from './text.ts';
import {readCommandPolicy,within,pathSegments,type CommandPolicy} from './command-policy.ts';
import {identityOf,identityKey,commandLine} from './typed-contract.ts';
import type {PlanSlots} from './slots.ts';
import type {AuthorityGap} from './typed-authority.ts';
export const definitionKey=(identity:CommandIdentity)=>JSON.stringify([identity.tree_root,identity.path,identity.signature]);
export interface Operation {line:string;pointer:string;object:string;cleanup:boolean}
function definitions(raw:unknown):CommandDefinition[]{
 if(!isRecord(raw)||typeof raw.root!=='string')return [];
 return (Array.isArray(raw.authority_entries)?raw.authority_entries:Array.isArray(raw.entries)?raw.entries:[]).flatMap(entry=>{
  if(!isRecord(entry)||!Array.isArray(entry.words)||entry.words.some(word=>typeof word!=='string')||!Array.isArray(entry.signatures)||typeof entry.reference!=='string')return [];
  const path='/commands/'+entry.words.map(encodeURIComponent).join('/'),ref='tree:'+raw.root+path;
  if(entry.reference!==ref&&!(entry.reference.slice(0,ref.length+1)===ref+'@'&&entry.reference.slice(ref.length+1).length===64))return [];
  return [{path,words:entry.words,signatures:entry.signatures} as CommandDefinition];
 });
}
export function commandObligations(operations:readonly Operation[],slots:PlanSlots,raw:unknown,sourceTexts:readonly string[]):AuthorityGap[]{
 if(!operations.length&&!sourceTexts.length)return [];
 const policy=readCommandPolicy(isRecord(raw)?raw.policy:undefined);
 const gaps:AuthorityGap[]=[];
 const note=(pointer:string,message:string,verdict:Extract<Verdict,'unknown'|'refute'>='refute',obligation?:Record<string,unknown>)=>gaps.push({document:'catalog',pointer,message,verdict,...(obligation?{obligation}:{})});
 if(!isRecord(raw)||typeof raw.root!=='string'||typeof raw.missing==='string'){note('/command_catalog',isRecord(raw)&&typeof raw.missing==='string'?raw.missing:'缺锁定目录，无法核对作者命令义务','unknown');return gaps;}
 const native=definitions(raw),grammar=compileGrammar(native);
 const parsed=operations.map(operation=>({...operation,identity:identityOf(commandIdentity(grammar,operation.line))}));
 if(parsed.some(operation=>!operation.identity))return gaps; // Native parse outcomes already block; do not guess missing identities.
 const main=parsed.filter(operation=>!operation.cleanup&&operation.identity),cleanup=parsed.filter(operation=>operation.cleanup&&operation.identity);
 // Cleanup is an explicit suffix, including host/wait steps; it cannot hide an execution operation after cleanup.
 let inCleanup=false;slots.steps.forEach((step,index)=>{if(step.cleanup===true)inCleanup=true;else if(inCleanup)note('/steps/'+index,'清理段必须是末尾连续步骤，执行步骤不能放在清理段之后');});
 const authored=new Map<string,{identity:CommandIdentity;count:number}>(),planned=new Map<string,number>();
 for(const text of sourceTexts)for(const line of commandLines(text)){const identity=identityOf(commandIdentity(grammar,line.text));if(identity){const key=definitionKey(identity),row=authored.get(key)??{identity,count:0};row.count++;authored.set(key,row);}}
 for(const operation of main){const key=definitionKey(operation.identity!);planned.set(key,(planned.get(key)??0)+1);}
 for(const [key,row]of authored){const actual=planned.get(key)??0;if(actual<row.count)note('/steps',`可以改参数，不可以删命令：${row.identity.path} 作者 ${row.count} 次、计划 ${actual} 次，尚缺 ${row.count-actual} 次`,'refute',{identity:{tree_root:row.identity.tree_root,path:row.identity.path,signature:row.identity.signature},required_count:row.count,planned_count:actual,missing_count:row.count-actual});}
 if(!policy){if(operations.length)note('/command_policy','缺锁定根的产品命令范围与逆操作声明；下一步：产品包作者声明 command-policy@1 后重新育苗并核验','unknown');return gaps;}
 const modifies=(identity:CommandIdentity)=>!policy.read_only.some(prefix=>within(identity.path,prefix));
 const configured=main.filter(operation=>modifies(operation.identity!)).reverse();
 const actual=cleanup.filter(operation=>modifies(operation.identity!));
 configured.forEach((operation,index)=>{
  const identity=operation.identity!;
  const matches=policy.inverse_rules.filter(rule=>within(identity.path,rule.source_prefix)).sort((a,b)=>pathSegments(b.source_prefix)!.length-pathSegments(a.source_prefix)!.length);
  const rule=matches[0];if(!rule||matches[1]&&rule.source_prefix===matches[1].source_prefix){note(operation.pointer,`配置命令 ${identity.path} 缺唯一的产品逆操作规则；下一步由产品包作者补声明后重核`,'unknown');return;}
  const path='/'+[...pathSegments(rule.inverse_prefix)!,...pathSegments(identity.path)!.slice(pathSegments(rule.source_prefix)!.length)].join('/');
  const received=actual[index];
  if(!received||received.object!==operation.object||received.identity!.path!==path){note(operation.pointer,`配置命令 ${identity.path} 缺同设备、逆序的清理操作 ${path}（清理命令必须由锁定树完整解析）`,'refute',{cleanup_for:operation.pointer,inverse_path:path,missing_count:1});return;}
  const parameters=[...identity.parameters].sort((a,b)=>a.position-b.position);
  const counts=rule.leading_parameters!==undefined?[rule.leading_parameters]:[...new Set(native.filter(definition=>definition.path===path).flatMap(definition=>definition.signatures.flatMap(signature=>Array.from({length:Math.min(signature.params.length,parameters.length)+1},(_,count)=>count))))];
  const copied=parameters.map((parameter,position)=>{const proposed=received.identity!.parameters.find(value=>value.position===position);return proposed&&commandTokens(parameter.raw)?.[0]?.value===commandTokens(proposed.raw)?.[0]?.value?proposed.raw:parameter.raw;});
  const inverses=new Map<string,CommandIdentity>();
  for(const count of counts){if(count>parameters.length)continue;const line=[...path.split('/').slice(2).map(decodeURIComponent),...copied.slice(0,count)].join(' ');const inverse=identityOf(commandIdentity(grammar,line));if(inverse&&inverse.path===path&&inverse.parameters.length===count)inverses.set(identityKey(inverse),inverse);if(inverses.size>1)break;}
  if(inverses.size!==1){note(operation.pointer,`配置命令 ${identity.path} 的逆操作 ${path} ${inverses.size>1?'没有唯一前导身份参数声明':'不能按锁定树完整解析'}；由产品包作者核对规则与命令树`,inverses.size>1?'unknown':'refute');return;}
  const inverse=[...inverses.values()][0];
  if(identityKey(received.identity!)!==identityKey(inverse))note(operation.pointer,`配置命令 ${identity.path} 在逆序位置的清理参数不等于声明的前导身份参数：${commandLine(inverse)}`,'refute',{cleanup_for:operation.pointer,inverse,missing_count:1});
 });
 if(actual.length>configured.length)for(const extra of actual.slice(configured.length))note(extra.pointer,'清理段含没有对应执行命令的额外配置操作');
 return gaps;
}
