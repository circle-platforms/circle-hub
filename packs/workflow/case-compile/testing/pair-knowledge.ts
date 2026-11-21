import {selectCatalog} from '../../../../hub/knowledge/catalog-selection.ts';
import {createCatalogView,type CatalogView} from '../../../../hub/rules/api.ts';
import type {RootInfo} from '../../../../hub/ports.ts';
import type {TreeReader} from '../../../../hub/refs/api.ts';
import {FakeKnowledge,ROOT} from './hub.ts';
import {DECLARATION,hubStore} from './hub-side.ts';
import {treeLines,type FlatCatalog} from './locked-tree.ts';
import {treeReaderOf} from './manual-tree.ts';

type Row={[key:string]:any};
export class PairKnowledge extends FakeKnowledge {
  readonly #tree:Row[];
  readonly #policy:unknown;
  readonly #whole:CatalogView;
  constructor(entries:FlatCatalog['entries'],policy:unknown,manual?:FlatCatalog['manual']){
    super();
    this.#tree=treeLines({root:ROOT,complete:true,entries,...(manual!==undefined?{manual}:{})});
    this.#policy=policy;
    const members=this.#tree.slice(1).flatMap((node)=>(node.entries as Row[]).filter((row)=>row.kind==='definition').map((row)=>({words:row.data.words,signatures:row.data.signatures,reference:row.reference})));
    this.#whole=createCatalogView(members,{reference:`tree:${ROOT}/commands`,complete:true,caseSensitive:true});
  }
  get tree():readonly Row[]{return this.#tree;}
  override treeReader():TreeReader{
    const reader=treeReaderOf(this.#tree);
    return {...reader,read:(root,path,entry,who)=>{this.treeReads.push(root+path+'@'+entry);return reader.read(root,path,entry,who);}};
  }
  override async catalog(root:string,id:string,selection?:{base:string;lines:string[]}):Promise<CatalogView|null>{
    if(root!==ROOT||id!=='commands@1')return null;
    if(!selection){this.fullCatalogReads++;return this.#whole;}
    this.selectedCatalogReads++;
    return selectCatalog({root,selection,declaration:DECLARATION as never,...hubStore(this.#tree)});
  }
  #withPolicy(info:RootInfo|null):RootInfo|null{return info===null?null:{...info,command_policy:structuredClone(this.#policy) as RootInfo['command_policy']};}
  override async currentRoot(product:string,line:string):Promise<RootInfo|null>{return this.#withPolicy(await super.currentRoot(product,line));}
  override async rootOfBuild(product:string,name:string):Promise<RootInfo|null>{return this.#withPolicy(await super.rootOfBuild(product,name));}
  override async rootInfo(root:string):Promise<RootInfo[]>{return (await super.rootInfo(root)).map((info)=>this.#withPolicy(info)!);}
}
