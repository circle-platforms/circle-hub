import {setup} from './context.ts';
export async function setupOwned(options:{certified?:boolean;declared?:boolean;word?:string;reason?:unknown}={}) {
  let currentWord=options.word??'staging_directory';
  const c=await setup({alter:(name,v)=>name==='read_blob'?{...v,ownership:currentWord,ownership_reason:options.reason??null,rows:[{id:'synthetic-case',outcome:'good',log:'SYNTHETIC_END'}]}:v});
  try {
    const proof=await c.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic attribution certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
    await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,premises:options.certified===false?{}:{result_ownership:{version:'1',evidence:[`src:${proof.body.sha256}`]}},result:{...c.executor.definition.result,...(options.declared===false?{}:{ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'}}),request_id:'/request',log:'/log',closing_marker:'SYNTHETIC_END'}});
    await c.freezeExecutor();
    return {...c,setWord:(word:string)=>{currentWord=word;},report:async(ref:string)=>{
      const source=await c.kit.artifacts.source(c.owner,ref.slice(4));if(!source?.bytes)throw new Error('synthetic report missing');return JSON.parse(new TextDecoder().decode(source.bytes));
    }};
  } catch(error) {await c.close();throw error;}
}
