import {z} from 'zod';
import {ApiError,Sha256,canonicalHash,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Transaction} from '../../storage/src/index.ts';
import type {Assets} from '../../assets/src/index.ts';
import type {ProductModules} from './product-modules.ts';
import type {AssetRevisionPin} from '../../knowledge/src/source-artifacts.ts';
export const ToolImplementation=z.object({schema:z.literal('hub-tool-implementation/1'),capabilityPackId:z.string(),flowVersion:z.string(),implementationSha256:Sha256}).strict();
export class ToolProviders{
  definitions=new Map<string,{capabilityPackId:string;version:string;flowVersion:string;implementationSha256:string}>();
  assets:Assets;
  products?:ProductModules;
  constructor(assets:Assets){this.assets=assets;}
  register(definition:{capabilityPackId:string;version:string;flowVersion:string;implementationSha256:string}){const previous=this.definitions.get(definition.capabilityPackId);requireCondition(!previous||canonicalHash(previous)===canonicalHash(definition),'INVALID_PAYLOAD','Tool implementation conflicts');this.definitions.set(definition.capabilityPackId,definition);}
  dependencies(asset:any){const config=ToolImplementation.parse(asset.configuration),definition=this.definitions.get(config.capabilityPackId);return !definition||asset.version!==definition.version||config.flowVersion!==definition.flowVersion||config.implementationSha256!==definition.implementationSha256?[{assetId:asset.asset_id,kind:'knowledge-source',reason:'tool-version-not-installed'}]:[];}
  async resolve(ctx:AuthContext,scope:string,capability:string,tx:Transaction,selector?:string|AssetRevisionPin){
    const policy=await this.assets.auth.check(ctx,'methods.use',scope,tx),pin=typeof selector==='object'?selector:undefined,assetId=typeof selector==='string'?selector:pin?.assetId;
    if(pin){requireCondition(typeof pin.assetId==='string'&&typeof pin.version==='string'&&pin.version.length>0,'INVALID_PAYLOAD','Method pin needs an asset and immutable version');Sha256.parse(pin.sha256);if(pin.digest!==undefined)Sha256.parse(pin.digest);}
    const rows=(await tx.query(`SELECT a.*,v.* FROM assets a JOIN asset_versions v USING(asset_id)
      WHERE a.tenant_id=$1 AND a.scope_id=$2 AND a.kind='knowledge-source' AND ($3::text IS NULL OR a.asset_id=$3)
      AND v.lifecycle IN ('approved','running') AND v.approved_digest=v.sha256
      AND (v.configuration->>'schema'='hub-tool-implementation/1' OR v.configuration->'metadata'->'module'->>'kind'='product-line')
      ORDER BY v.created_at DESC,v.version DESC,a.asset_id`,[policy.tenantId,scope,assetId??null])).rows;
    // Choose the latest approved revision before applying its readers. A newly
    // approved ACL cannot be bypassed by falling back to an older readable row.
    const latest=new Map<string,any>();for(const row of rows)if(!latest.has(row.asset_id))latest.set(row.asset_id,row);
    const readable=(row:any)=>row&&(row.owner_principal_id===policy.principalId||Array.isArray(row.readers)&&(row.readers.includes(policy.principalId)||row.readers.includes('*'))),selected=pin?rows.filter(row=>row.asset_id===pin.assetId&&row.version===pin.version):[...latest.values()],candidates:any[]=[];
    for(const row of selected){
      if(!readable(row)||!readable(latest.get(row.asset_id)))continue;
      if(pin)requireCondition(row.sha256===pin.sha256,'APPROVAL_STALE','Frozen method SHA differs from its approved revision');
      const module=row.configuration.metadata?.module;
      if(module?.kind==='product-line'&&this.products){
        if(pin?.digest!==undefined)requireCondition(module.digest===pin.digest,'APPROVAL_STALE','Frozen method module digest differs');
        const selectedPin={assetId:row.asset_id,version:row.version,sha256:row.sha256,...(module.digest?{digest:module.digest}:{})},loaded=await this.products.load(ctx,row.asset_id,scope,tx,selectedPin);
        if(loaded.flows.some(flow=>flow.id===capability))candidates.push({...loaded.binding,capabilityPackId:capability,hookAssetId:row.asset_id,toolPaths:loaded.manifest.tools.map(tool=>tool.manifest)});
      }else if(row.configuration.schema==='hub-tool-implementation/1'){
        const definition=this.definitions.get(capability),config=row.configuration;
        if(definition&&row.version===definition.version&&config.capabilityPackId===capability&&config.implementationSha256===definition.implementationSha256&&config.flowVersion===definition.flowVersion){requireCondition(pin?.digest===undefined,'APPROVAL_STALE','A native implementation has no product module digest binding');candidates.push({assetId:row.asset_id,sha256:row.sha256,...definition});}
      }
    }
    if(candidates.length!==1)throw new ApiError('SOURCE_NOT_APPROVED','Select one approved Tool implementation explicitly',{ruleId:'approved-method-version',ruleVersion:'1.0.0',capabilityPackId:capability,...(assetId?{assetId}:{}),candidateCount:candidates.length});return candidates[0];
  }
}
