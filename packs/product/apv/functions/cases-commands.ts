// R4 / C07: use one locked build grammar for titles, ancestor labels, operations and expectations.
// Each original line is a whole candidate slot; no phrase extraction, alias, prefix or spelling normalization.
import { produceCommandEntries,bindCommandSource } from './command-tree.ts';
import { compileGrammar, commandLines, parseCommand, parseCommandState, commandIdentity, type CommandGrammar, type CommandDefinition } from './commands.ts';
import type { XmlModel } from './types.ts';
import type { CatalogSignature } from '../../../../contracts/src/tables.ts';
import { isRecord } from './util.ts';
export type CommandCatalog = CommandGrammar;
export function commandCatalog(model:XmlModel,source?:string):{catalog:CommandCatalog;warnings:string[]} {
  const produced=produceCommandEntries(model,{});
  const declarationsByPath=produced.declarations??{};
  const definitions=(source?bindCommandSource(produced.entries,source,declarationsByPath):produced.entries).flatMap(entry=>{
    if(!entry.path||!isRecord(entry.data)||!Array.isArray(entry.data.words)||!Array.isArray(entry.data.signatures))return [];
    const declarations=(entry.path===null?undefined:declarationsByPath[entry.path]) as CommandDefinition['declarations'];
    return [{path:entry.path,words:entry.data.words as string[],declarations,signatures:(entry.data.signatures as CatalogSignature[]).map(signature=>({...signature,...(source&&declarations?.[signature.id??'']?{reference:`src:${source}/xml@1/${declarations[signature.id??''].selector}`}: {})}))}];
  });
  const catalog=compileGrammar(definitions);catalog.tree_root=source;return {catalog,warnings:produced.warnings};
}
export function resolvePhrasePaths(catalog:CommandCatalog,phrase:string):string[]{const path=parseCommand(catalog,phrase);return path===null?[]:[path];}
export function resolvePhrase(catalog:CommandCatalog,phrase:string):string|null{return parseCommand(catalog,phrase);}
// Historical public helpers are identity functions; retaining the names cannot restore heuristic folding.
export const foldText=(text:string):string=>text;
export const withoutListNumbers=(text:string):string=>text;
export type TextCommands={paths:string[];phrases:number;unresolved:number;identities?:import('../../../../contracts/generated/shared-interfaces.ts').CommandIdentity[];states?:ReturnType<typeof parseCommandState>[]};
export function textCommands(catalog:CommandCatalog,texts:readonly string[]):{results:TextCommands[];warnings:string[]} {
  const results=texts.map(text=>{
    const lines=commandLines(text);const paths=new Set<string>();const identities:import('../../../../contracts/generated/shared-interfaces.ts').CommandIdentity[]=[];const states:ReturnType<typeof parseCommandState>[]=[];let unresolved=0,phrases=0;
    for(const line of lines){if(!line.text.length)continue;const state=parseCommandState(catalog,line.text);states.push(state);if(state.status!=='not_command')phrases++;const path=state.path;if(state.status==='parameters_unchecked')unresolved++;if(path!==null){paths.add(path);const identity=commandIdentity(catalog,line.text);if(identity){identities.push(identity);}else {unresolved++;state.missing='缺少冻结树摘要或唯一完整的命令身份';state.exit={next_action:'包作者绑定冻结树并补唯一完整签名后重产',audience:'包作者',due:'下一次生产之前'};}}}
    return {paths:[...paths].sort((a,b)=>a<b?-1:a>b?1:0),phrases,unresolved,states,identities};
  });
  return {results,warnings:[]};
}

/** The same fully consumed identity check for authored steps in either mind-map layout. A step with any
 * unparsed line (or no checked tree) stays in the missing-step count; parent labels and expectations cannot fill it. */
export function stepCommands(catalog:CommandCatalog|null,steps:readonly {text:string}[]):{commands:import('../../../../contracts/generated/shared-interfaces.ts').CommandIdentity[];unparsed_steps:number}{
 const parsed=catalog?textCommands(catalog,steps.map(step=>step.text)).results:[];
 return {commands:parsed.flatMap(row=>row.identities??[]),unparsed_steps:steps.filter((_,index)=>!parsed[index]?.states?.length||parsed[index].identities?.length!==parsed[index].states?.length).length};
}
