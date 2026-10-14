import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ApiError} from '../../packages/contracts/src/index.ts';
import {ToolProviders} from '../../packages/methods/src/providers.ts';

const actor:any={principalId:'prn_reader',tenantId:'tnt_fixture',kind:'user'},scope='scp_fixture',capability='fixture-execute',nativeDigest='a'.repeat(64);
const assetA='ast_'+'1'.repeat(32),assetB='ast_'+'2'.repeat(32);
function revision(assetId=assetA,version='1.0.0',options:any={}){return {asset_id:assetId,tenant_id:actor.tenantId,scope_id:scope,owner_principal_id:'prn_owner',kind:'knowledge-source',version,current_version:version,sha256:version==='1.0.0'?'b'.repeat(64):'c'.repeat(64),approved_digest:version==='1.0.0'?'b'.repeat(64):'c'.repeat(64),lifecycle:'approved',readers:[actor.principalId],created_at:new Date(version==='1.0.0'?'2020-01-01':'2020-01-02'),configuration:{schema:'hub-tool-implementation/1',capabilityPackId:capability,flowVersion:'fixture-execute/1',implementationSha256:nativeDigest},...options};}
function fixture(rows:any[]){
 const state={rows,authorized:true,scopes:[scope],productLoads:[] as any[]};
 const auth={check:async(_ctx:any,grant:string,selectedScope:string)=>{if(!state.scopes.includes(selectedScope))throw new ApiError('FORBIDDEN_SCOPE','Synthetic scope denied');if(!state.authorized&&grant==='methods.use')throw new ApiError('FORBIDDEN_ACTION','Synthetic method denied');return {...actor,scopes:state.scopes};}};
 const tx:any={query:async(sql:string,params:any[])=>{
  let selected=state.rows.filter(row=>row.tenant_id===params[0]&&row.scope_id===params[1]&&['approved','running'].includes(row.lifecycle)&&row.approved_digest===row.sha256);
  // Reproduce the old current-version join while allowing the revised loader
  // to inspect immutable historical rows. The fake never executes a runtime.
  if(sql.includes('v.version=a.current_version'))selected=selected.filter(row=>row.version===row.current_version);
  const products=sql.includes("->>'kind'='product-line'"),native=sql.includes("->>'schema'='hub-tool-implementation/1'");
  if(products&&!native)selected=selected.filter(row=>row.configuration.metadata?.module?.kind==='product-line');
  if(native&&!products)selected=selected.filter(row=>row.configuration.schema==='hub-tool-implementation/1');
  if(typeof params[2]==='string'&&params[2].startsWith('ast_'))selected=selected.filter(row=>row.asset_id===params[2]);
  if(typeof params[3]==='string'&&params[3].startsWith('ast_'))selected=selected.filter(row=>row.asset_id===params[3]);
  selected.sort((a,b)=>b.created_at.getTime()-a.created_at.getTime()||b.version.localeCompare(a.version));return {rows:selected};
 }};
 const assets:any={auth,row:async(_ctx:any,id:string)=>{const selected=state.rows.find(row=>row.asset_id===id&&row.version===row.current_version);if(!selected)throw new ApiError('ASSET_NOT_VISIBLE','Synthetic asset denied');return selected;}};
 const providers=new ToolProviders(assets);providers.register({capabilityPackId:capability,version:'1.0.0',flowVersion:'fixture-execute/1',implementationSha256:nativeDigest});
 providers.products={load:async(_ctx:any,id:string,_scope:string,_tx:any,pin:any)=>{state.productLoads.push(pin);const selected=state.rows.find(row=>row.asset_id===id&&row.version===(pin?.version??row.current_version));if(!selected||!['approved','running'].includes(selected.lifecycle))throw new ApiError('APPROVAL_REQUIRED','Synthetic product unavailable');return {binding:{assetId:id,version:selected.version,sha256:selected.sha256,digest:selected.configuration.metadata.module.digest},manifest:{tools:[]},flows:[{id:capability}]};}} as any;
 return {state,providers,tx};
}
function product(assetId=assetA,version='1.0.0',options:any={}){return revision(assetId,version,{configuration:{metadata:{module:{kind:'product-line',digest:'d'.repeat(64)}}},...options});}

test('Historical providers: a draft current pointer does not hide an approved native revision or change its frozen binding',async()=>{
 const old=revision(),draft=revision(assetA,'2.0.0',{lifecycle:'draft',approved_digest:null}),{providers,tx}=fixture([{...old,current_version:draft.version},draft]);
 const pin={assetId:assetA,version:old.version,sha256:old.sha256};const frozen=await providers.resolve(actor,scope,capability,tx,pin as any);assert.equal(frozen.version,old.version);assert.equal(frozen.sha256,old.sha256);
 const compatible=await providers.resolve(actor,scope,capability,tx,assetA);assert.equal(compatible.sha256,old.sha256);
});
test('Historical providers: product resolution passes the requested version SHA and digest rather than a new current draft',async()=>{
 const old=product(),draft=product(assetA,'2.0.0',{lifecycle:'draft',approved_digest:null}),{providers,tx,state}=fixture([{...old,current_version:draft.version},draft]),pin={assetId:assetA,version:old.version,sha256:old.sha256,digest:old.configuration.metadata.module.digest};
 const result=await providers.resolve(actor,scope,capability,tx,pin as any);assert.deepEqual(state.productLoads,[pin]);assert.equal(result.version,old.version);assert.equal(result.sha256,pin.sha256);
});
test('Historical providers: multiple approved product implementations require an explicit asset rather than query order',async()=>{
 const {providers,tx}=fixture([product(assetA),product(assetB)]);await assert.rejects(providers.resolve(actor,scope,capability,tx),(error:any)=>error.code==='SOURCE_NOT_APPROVED');const chosen=await providers.resolve(actor,scope,capability,tx,assetB);assert.equal(chosen.assetId,assetB);
});
test('Historical providers: native and product implementations are both candidates and cannot silently override each other',async()=>{
 const {providers,tx}=fixture([revision(assetA),product(assetB)]);await assert.rejects(providers.resolve(actor,scope,capability,tx),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
});
test('Historical providers: current authorization and both historical and latest approved reader boundaries are rechecked',async()=>{
 const {providers,tx,state}=fixture([product()]);const chosen=await providers.resolve(actor,scope,capability,tx,assetA);assert.equal(chosen.assetId,assetA);state.authorized=false;await assert.rejects(providers.resolve(actor,scope,capability,tx,assetA),(error:any)=>error.code==='FORBIDDEN_ACTION');state.authorized=true;state.scopes=[];await assert.rejects(providers.resolve(actor,scope,capability,tx,assetA),(error:any)=>error.code==='FORBIDDEN_SCOPE');
 const old=revision(),latest=revision(assetA,'2.0.0',{readers:['prn_other']}),second=fixture([{...old,current_version:latest.version},latest]);await assert.rejects(second.providers.resolve(actor,scope,capability,second.tx,{assetId:assetA,version:old.version,sha256:old.sha256} as any),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
});
test('Historical providers: disabled retired unapproved and changed-hash pins are refused',async()=>{
 for(const lifecycle of ['disabled','retired','draft']){const row=revision(assetA,'1.0.0',{lifecycle}),{providers,tx}=fixture([row]);await assert.rejects(providers.resolve(actor,scope,capability,tx,{assetId:assetA,version:row.version,sha256:row.sha256} as any),(error:any)=>error.code==='SOURCE_NOT_APPROVED');}
 const {providers,tx}=fixture([revision()]);await assert.rejects(providers.resolve(actor,scope,capability,tx,{assetId:assetA,version:'1.0.0',sha256:'f'.repeat(64)} as any),(error:any)=>error.code==='APPROVAL_STALE');await assert.rejects(providers.resolve(actor,scope,capability,tx,{assetId:assetA,version:'1.0.0',sha256:'b'.repeat(64),digest:'f'.repeat(64)} as any),(error:any)=>error.code==='APPROVAL_STALE');
});
test('Historical providers: later approved product revisions leave an explicit old pin unchanged and only legacy selection advances',async()=>{
 const old=product(),latest=product(assetA,'2.0.0'),{providers,tx}=fixture([{...old,current_version:latest.version},latest]),pin={assetId:assetA,version:old.version,sha256:old.sha256,digest:old.configuration.metadata.module.digest};
 const retained=await providers.resolve(actor,scope,capability,tx,pin as any),next=await providers.resolve(actor,scope,capability,tx,assetA);assert.equal(retained.version,old.version);assert.equal(retained.sha256,old.sha256);assert.equal(next.version,latest.version);assert.equal(next.sha256,latest.sha256);
});
test('Historical providers: a mismatched product digest or historical reader revocation cannot reuse a frozen pin',async()=>{
 const old=product(),{providers,tx}=fixture([old]);await assert.rejects(providers.resolve(actor,scope,capability,tx,{assetId:assetA,version:old.version,sha256:old.sha256,digest:'f'.repeat(64)} as any),(error:any)=>error.code==='APPROVAL_STALE');
 old.readers=['prn_other'];await assert.rejects(providers.resolve(actor,scope,capability,tx,{assetId:assetA,version:old.version,sha256:old.sha256} as any),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
});
