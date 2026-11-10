import assert from 'node:assert/strict';
import {test} from 'node:test';
import {KnowledgeError} from '../../knowledge/api.ts';
import {newId} from '../../records/api.ts';
import type {PageContext} from './pages.ts';
import {recoverEditor} from './form-recovery.ts';

const ctx={principal:{id:newId('usr'),role:'user',name:'合成作者'},csrf:'synthetic-session-csrf',chrome:(title:string,extra:unknown)=>({title,...extra as object,user:null,csrf:null})} as PageContext;

test('a refused editor keeps safe draft text and concurrency tokens but renews the refused memory intent',()=>{
 const values=new URLSearchParams({space:'personal',title:'合成草稿',markdown:'<script>合成纯文本</script>',path:'/draft',document:'a'.repeat(64),expected_version:'b'.repeat(64),client_key:'refused-intent',csrf:'untrusted-csrf',password:'do-not-return'});
 const result=recoverEditor(ctx,'memory-write',values,new KnowledgeError('合成大小限制',{code:'MEMORY_DOCUMENT_LIMIT'}));assert.ok(result);
 assert.equal(result.status,400);const body=String(result.body);
 for(const text of ['合成草稿','&lt;script&gt;合成纯文本&lt;/script&gt;','value="'+values.get('expected_version')+'"','synthetic-session-csrf','MEMORY_DOCUMENT_LIMIT'])assert.ok(body.includes(text),text);
 assert.doesNotMatch(body,/untrusted-csrf|do-not-return|refused-intent|<script>合成纯文本/);
 assert.match(body,/<form[^>]*action="\/console\/knowledge\/do\/memory-write"/);
});

test('unsafe editor fields are omitted even when the failure occurred before scanning',()=>{
 const secret='DB_PASSWORD='+['Synth3tic','!2948'].join('');
 const result=recoverEditor(ctx,'memory-write',new URLSearchParams({title:'合成安全标题',path:'/safe',markdown:secret}),new KnowledgeError('合成大小限制',{code:'MEMORY_DOCUMENT_LIMIT'}));assert.ok(result);
 assert.ok(!String(result.body).includes(secret));assert.match(String(result.body),/未回填/);assert.match(String(result.body),/合成安全标题/);
});

test('knowledge JSON drafts and multiple source rows survive format errors without adding unrecognized fields',()=>{
 const result=recoverEditor(ctx,'entry',new URLSearchParams({space:ctx.principal.id,path:'/draft',kind:'observation',statement:'合成陈述',data:'{invalid',applicability:'null',ground_0:'src:'+'a'.repeat(64),quotation_0:'合成引文',ground_7:'src:'+'b'.repeat(64),quotation_7:'合成第八引文',expected_version:'c'.repeat(64),replaces:'d'.repeat(64),reason:'合成修订',injected:'unsafe-extra'}),new SyntaxError('synthetic JSON failure'));
 assert.ok(result);const body=String(result.body);for(const text of ['{invalid','合成第八引文','name="ground_7"','name="replaces"','合成陈述'])assert.ok(body.includes(text));assert.doesNotMatch(body,/unsafe-extra/);
});

test('neutral permission and unexpected server failures are not turned into editable successful pages',()=>{
 assert.equal(recoverEditor(ctx,'memory-write',new URLSearchParams({markdown:'合成正文'}),new KnowledgeError('不可读',{code:'SOURCE_UNAVAILABLE'})),null);
 assert.equal(recoverEditor(ctx,'memory-write',new URLSearchParams({markdown:'合成正文'}),new Error('synthetic internal failure')),null);
 assert.equal(recoverEditor(ctx,'memory-share',new URLSearchParams(),new SyntaxError('synthetic malformed')),null);
});
