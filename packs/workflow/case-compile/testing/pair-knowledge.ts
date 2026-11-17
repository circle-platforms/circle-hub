// The Hub's fake knowledge port with a command tree and a command policy of the test's own, whose catalog selection is the Hub's
// own (hub/knowledge/catalog-selection.ts over the nodes of an export: testing/hub-side.ts), not a filter of the entries. The tree is
// served under the root the fake knowledge locks for the build. Test support only.
import {selectCatalog} from '../../../../hub/knowledge/catalog-selection.ts';
import {createCatalogView,type CatalogView} from '../../../../hub/rules/api.ts';
import type {RootInfo} from '../../../../hub/ports.ts';
import {FakeKnowledge,ROOT} from './hub.ts';
import {DECLARATION,hubStore} from './hub-side.ts';
import {treeLines,type FlatCatalog} from './locked-tree.ts';

type Row={[key:string]:any};
export class PairKnowledge extends FakeKnowledge {
  readonly #tree:Row[];
  readonly #policy:unknown;
  readonly #whole:CatalogView;
  constructor(entries:FlatCatalog['entries'],policy:unknown){
    super();
    this.#tree=treeLines({root:ROOT,complete:true,entries});
    this.#policy=policy;
    const members=this.#tree.slice(1).flatMap((node)=>(node.entries as Row[]).map((row)=>({words:row.data.words,signatures:row.data.signatures,reference:row.reference})));
    this.#whole=createCatalogView(members,{reference:`tree:${ROOT}/commands`,complete:true,caseSensitive:true});
  }
  /** The head of the export a run of this root downloads: the tree this port serves. */
  get tree():readonly Row[]{return this.#tree;}
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
