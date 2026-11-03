import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactShareKey } from '../records/api.ts';
import { createDefaultRegistry } from '../refs/api.ts';
import { openTestRecords } from '../testing/records.ts';
import { callTool } from './tools.ts';

test('get_nodes keeps a share revoked during one request and the next call sees the revocation', async () => {
  const kit=await openTestRecords();
  try {
    const admin=(await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner=await kit.principals.createUser(admin,'synthetic-owner'),reader=await kit.principals.createUser(admin,'synthetic-reader');
    const source=await kit.artifacts.ingest({bytes:Buffer.from('synthetic content'),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:true,packs:[],shareable:true}});
    const key=artifactShareKey(source);await kit.authorizations.share(admin,key,[reader.id]);
    const parsers=createDefaultRegistry();let once=false;
    parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:1000,maxDepth:2,maxNodes:10},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],async locate(){if(!once){once=true;await kit.authorizations.unshare(admin,key,reader.id);}return {selector:'n/x',text:'synthetic content',byteRange:null};}};}});
    const deps={records:kit,parsers,knowledge:{treeReader:()=>({})},runs:{}} as unknown as Parameters<typeof callTool>[0];
    const makeCall=()=>({principal:reader,context:{traceId:'a'.repeat(32),sessionId:'synthetic',adminNote:()=>{}},state:{method:'tools/call',tool:'get_nodes',args:null,started:0,runId:null,callResult:null,acceptance:null,errorCode:null,notes:[]}}) as unknown as Parameters<typeof callTool>[1];
    const args={reference:`src:${source.body.sha256}/synthetic@1/n/x`};
    const first=await callTool(deps,makeCall(),'get_nodes',args);
    assert.equal(first.isError,false);assert.equal((first.structuredContent.content as {text:string}).text,'synthetic content');
    const second=await callTool(deps,makeCall(),'get_nodes',args);
    assert.equal(second.isError,true);assert.ok(!JSON.stringify(second).includes('synthetic content'));
  } finally { await kit.close(); }
});
