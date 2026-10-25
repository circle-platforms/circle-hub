// Product-owned SVN traversal and one independently memoized manual production per name family.
import type {ProducerInput,ProducerOutput,BuildInfo} from '../../../../../contracts/src/product.ts';
import {PRODUCT_LINE} from '../naming.ts';
import {manual} from '../producers.ts';
import {commandCatalog} from '../cases-commands.ts';
import {isRecord} from '../util.ts';
import {compileFamilies,familyManualName} from './families.ts';
import {toK1Model} from './k1-model.ts';
import {produceAdocEntries,catalogOnAdocLine,catalogRefusal} from './entries.ts';
import {sha256,canonical} from './input.ts';
import {SIGNATURE_STRUCTURE} from './structure.ts';
import {ADOC_LIMITS,ManualSourceError,booksOf,directoryOf,listedSources,mainsOf,rootId,stop} from './tree.ts';

export {ADOC_LIMITS,ManualSourceError,directoryOf};
export const adocRole=(family:string,kind:'meta'|'files')=>'adoc_'+family.toLowerCase()+'_'+kind;

/** Add directory metadata and a complete file list to each own-tree build; failed reads remain required production inputs. */
export function addAdocSources(build:BuildInfo,options:Record<string,unknown>,read:Record<string,{ok?:unknown;parser?:unknown;model?:unknown}>,want:(id:string)=>void,notes:string[]):void{
 if(build.base!==build.name||!build.sources.tree)return;
 const settings=isRecord(options.adoc)?options.adoc:{};
 for(const family of PRODUCT_LINE.names){
  const config=isRecord(settings[family])?settings[family]:{};
  try{
   const root=directoryOf(config.root??null,build.line);if(root===null)continue;
   build.sources[adocRole(family,'meta')]=rootId(root);build.sources[adocRole(family,'files')]=[];
   const walk=booksOf(root,mainsOf(config.main,config.app_main),id=>{
    const page=read[id];if(page===undefined)return undefined;
    if(!page.ok||page.parser!=='json@1')return stop('directory_unreadable',`名称族 ${family} 的目录清单读不出`,`请管理员核对 SVN 资源和 ${family}_ADOC_ROOT，保留旧根，重跑同步`);
    return page.model;
   });
   walk.pending.forEach(want);
   const files:string[]=[];const seen=new Set<string>();
   for(const group of walk.groups)for(const id of listedSources(group.directory,group.tree))if(!seen.has(id)){seen.add(id);files.push(id);}
   build.sources[adocRole(family,'files')]=files;
  }catch(error){if(!(error instanceof ManualSourceError))throw error;notes.push(`${family}_ADOC_ROOT / ${family}_ADOC_MAIN：${error.message}，旧根不动`);}
 }
}

/** Entry point shared by separate family declarations; the payload never contains the other family's variables. */
export async function familyManual(input:ProducerInput):Promise<ProducerOutput>{
 const family=input.params.family;
 if(typeof family!=='string'||!(PRODUCT_LINE.names as readonly string[]).includes(family))return stop('family_not_a_name','生产器需要 product.json names 中的一个名称族');
 if(!input.build)throw new TypeError('名称族手册构建生产缺少 build；下一步：按构建生产器声明绑定具体构建后重新生产');
 if(input.params.root===null)return manual(input);
 const root=directoryOf(input.params.root,input.build.line)!;
 const meta=input.slots.meta;
 if(!meta||meta.parser!=='json@1')return stop('directory_unreadable',`名称族 ${family} 缺少固定修订号的目录清单`,`请管理员核对 SVN 资源和 ${family}_ADOC_ROOT 后重跑同步，旧根不动`);
 const given=input.lists?.files??[];
 const byId=new Map(given.map(slot=>[slot.external,slot]));
 if(byId.size!==given.length)return stop('duplicate_file','文件组重复绑定同一个来源');
 const declared=mainsOf(input.params.main,input.params.app_main);
 if(declared===null)return stop('missing_main','CLI 与 APP 都要给出主文件相对路径');
 // A file group also carries fixed-revision directory projections. The walker asks for
 // their exact identities from parent directory fields; never classify an adoc body as JSON.
 const walk=booksOf(root,declared,id=>{
  if(id===rootId(root))return meta.model;
  const slot=byId.get(id);if(!slot)return undefined;
  if(slot.parser==='json@1')return slot.model; // Existing direct-call inputs already parsed by the core.
  if(slot.parser!=='text@1'||!isRecord(slot.model)||typeof slot.model.raw_utf8!=='string')return stop('directory_unreadable','固定修订号的子目录清单缺少完整 UTF-8 原件结构');
  if(sha256(slot.model.raw_utf8)!==slot.sha256)return stop('source_digest','子目录清单的原件字节摘要与绑定槽位不符');
  try{return JSON.parse(slot.model.raw_utf8);}catch{return stop('directory_unreadable','固定修订号的子目录清单不是完整 JSON 结构');}
 });
 if(walk.pending.length)return stop('incomplete_group','缺少固定修订号的子目录清单，不读取不完整文件组');
 const expected=new Set(walk.groups.flatMap(group=>listedSources(group.directory,group.tree)));
 if(expected.size!==given.length||given.some(slot=>!slot.external||!expected.has(slot.external)))return stop('incomplete_group','需要每本书目录里的全部 adoc 和子目录清单，不能拆批、漏文件或混入其他目录');
 if(input.params.signature_structure!==undefined&&canonical(input.params.signature_structure)!==canonical(SIGNATURE_STRUCTURE))return stop('signature_structure','手册签名结构与包声明不一致，不能猜测签名','包作者恢复 product.json 签名结构与同版本实现的一致性，再按原件修订号重产');
 for(const name of ['cli','app'])if(catalogOnAdocLine(input.slots[name])){const refusal=catalogRefusal(family);throw new ManualSourceError(refusal.code,refusal.message,refusal.next_action);}
 const attributes=isRecord(input.params.attributes)?input.params.attributes:{};
 const treeSlot=input.slots.tree;
 const catalog=treeSlot?.parser==='xml@1'?commandCatalog(treeSlot.model as Parameters<typeof commandCatalog>[0],treeSlot.sha256).catalog:null;
 const entries:ProducerOutput['entries']=[],unplaced:NonNullable<ProducerOutput['unplaced']>=[],warnings:string[]=[];
 for(const group of walk.groups){
  if(group.tree.revision!==walk.revision)return stop('directory_identity',`${group.directory} 的修订号不是这组目录的 ${walk.revision}`);
  const files:Record<string,{text:string;revision:string;sha256:string}>=Object.create(null);
  for(const [name,member] of group.tree.files){
   const slot=byId.get(member.external!);
   if(!slot||slot.parser!=='text@1'||!isRecord(slot.model)||typeof slot.model.raw_utf8!=='string')return stop('non_utf8','adoc 需要可往返为原件字节的 UTF-8 文本，不拼接规范化后的行');
   const text=slot.model.raw_utf8;
   if(sha256(text)!==slot.sha256||Buffer.byteLength(text)!==member.size)return stop('source_digest','文件的原件字节摘要或长度不合目录清单与绑定槽位');
   files[name]={text,revision:group.tree.revision,sha256:slot.sha256};
  }
  for(const main of group.mains){
   if(!group.tree.files.has(main.file))return stop('missing_main',main.book+' MAIN 指定的主文件不在本修订号的完整文件组里');
   const compiled=await compileFamilies({main:main.file,revision:group.tree.revision,directory:group.directory,families:files,familyAttributes:attributes},[family]);
   if(!compiled.ok)throw new ManualSourceError(compiled.error.code,compiled.error.message,compiled.error.next_action);
   const one=compiled.families[family],name=familyManualName(family,main.book);
   const mapped=toK1Model(one.model,one.composition,name);
   const placed=produceAdocEntries(mapped,{name,slot:'files',catalog,known_builds:input.known_builds,models:input.params.models as string[]|undefined,platforms:input.params.platforms as string[]|undefined,components:input.params.components as string[]|undefined,licenses:input.params.licenses as string[]|undefined,deployment_forms:input.params.deployment_forms as string[]|undefined});
   if(!placed.ok&&placed.incomplete)return {entries:[],warnings:[],incomplete:placed.incomplete};
   if(!placed.ok)throw new ManualSourceError(placed.error.code,placed.error.message,placed.error.next_action);
   entries.push(...placed.entries);unplaced.push(...placed.unplaced);
   warnings.push(...placed.warnings.map(warning=>`${name}：${warning}`),one.attributes.note,`名称族 ${family} / ${main.book}：生产报告 ${canonical(one.report)}`,`名称族 ${family} / ${main.book}：组成 ${canonical({directory:one.composition.directory,revision:one.composition.revision,files:one.composition.files})}`);
  }
 }
 for(const name of walk.unread)warnings.push(`${name} 未读：不在任何主文件目录内`);
 return {entries,unplaced,warnings};
}
export default familyManual;
