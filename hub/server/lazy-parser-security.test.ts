import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import { openPackTestbed } from '../runs/packs/testing/setup.ts';
import { createSkillParserRegistry } from '../refs/skills.ts';
import { callTool } from './tools.ts';

// Synthetic pack inputs only; still exercise the real sandbox wrapper on platforms without OS isolation.
test('eager and deferred parser errors cannot disclose function-only bytes or paths to the model or admin note', async () => {
  const postgres=await startPostgres(); const bed=await openPackTestbed({postgres});
  try {
    const script=`export default function(input){const text=Buffer.from(input.bytes,'base64').toString();if(text.startsWith('eager|'))return {error:{name:'ParseSyntaxError',message:text}};const q={stream:'',units:[]};return {document:{parser:'synthetic@1',model:{},summary:text.startsWith('summary|')?{leak:text}:{},selectors:['n/x'],properties:['n/x'],quotation:{plain:q,properties:q}}}}\nexport function locate(input){const text=Buffer.from(input.bytes,'base64').toString();if(text.startsWith('throw|'))throw new Error(text);if(text.startsWith('summary|'))return {fragments:[{lookup:'n/x',selector:'n/'+Buffer.from(text).toString('hex'),text,byteRange:null}]};return {error:{name:'ParseSyntaxError',message:text}}}\n`;
    const row={parser:'synthetic@1',media_types:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:20,maxNodes:100},function:{module:'functions/parse.ts',export:'default'},locate:{module:'functions/parse.ts',export:'locate'}};
    const publication=await bed.attempt(bed.alice,{id:'synthetic-format',version:'1.0.0',kind:'skill',title:'Synthetic',description:'Synthetic',files:{'SKILL.md':'# Synthetic skill\n','functions/parse.ts':script,'skill.json':{schema:'skill@1',parsers:[row]}}});
    assert.equal(publication.ok,true,JSON.stringify(publication));
    await bed.registry.install(bed.admin,'synthetic-format@1.0.0');
    const facade=createSkillParserRegistry({registry:bed.registry,records:bed.kit,sandbox:{requireOsIsolation:false}}), {parsers}=await facade.freeze!([]);
    for(const mode of ['eager','lazy','throw','summary']){
      const secret=`${mode}|SYNTHETIC_PRIVATE_CONTENT /synthetic/private/secret`;
      const source=await bed.kit.artifacts.ingest({bytes:Buffer.from(secret),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:bed.alice.id},provenanceType:'declared',visibility:{readers:[bed.alice.id],admins:true,packs:[],shareable:false},readTier:'function_bytes_only'});
      const notes:string[]=[];
      const deps={records:bed.kit,parsers,knowledge:{treeReader:()=>({})},runs:{}} as unknown as Parameters<typeof callTool>[0];
      const call={principal:bed.alice,context:{traceId:'a'.repeat(32),sessionId:'synthetic',adminNote:(value:string)=>notes.push(value)},state:{method:'tools/call',tool:'get_nodes',args:null,started:0,runId:null,callResult:null,acceptance:null,errorCode:null,notes:[]}} as unknown as Parameters<typeof callTool>[1];
      const result=await callTool(deps,call,'get_nodes',{reference:`src:${source.body.sha256}/synthetic@1/n/x`});
      const denied=await bed.kit.artifacts.source(bed.alice,source.body.sha256,{consumer:'model'});
      assert.ok(denied === null || denied.bytes === null);
      assert.equal(result.isError,mode!=='summary',mode);
      assert.ok(!JSON.stringify(result).includes(secret),mode);
      assert.ok(!JSON.stringify(result).includes(Buffer.from(secret).toString('hex')),mode);
      assert.ok(!JSON.stringify(notes).includes(secret),mode);
      if(mode!=='summary') assert.match(JSON.stringify(result),mode==='eager'?/REFERENCE_UNRESOLVED/:mode==='lazy'?/SOURCE_UNPARSEABLE/:/SOURCE_RETRYABLE.*FUNCTION_THREW/);
      else assert.equal((result.structuredContent.content as {reference:string}).reference,`src:${source.body.sha256}/synthetic@1/n/x`);
    }
  } finally { await bed.close(); await postgres.stop(); }
});
