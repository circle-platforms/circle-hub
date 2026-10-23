// The actual product producer and the generic reader use one frozen declaration, including literals beyond the former cap.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after,before,test } from 'node:test';
import { ProductDeclaration, type KnownBuild } from '../../../../contracts/src/product.ts';
import { LinksView } from '../../../../contracts/src/views.ts';
import { createKnowledge,createKnowledgeReader,type Knowledge } from '../../../../hub/knowledge/api.ts';
import { FakeExternal,FakePacks } from '../../../../hub/knowledge/test-support.ts';
import { createDefaultRegistry } from '../../../../hub/refs/api.ts';
import { osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { openTestRecords,type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { startPostgres,type TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import type { ProductHandle } from '../../../../hub/ports.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
class Manuals extends FakeExternal{override async accepts(id:string){return id.startsWith('manual:')||super.accepts(id);}}
const tree='<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add"><arguments><arg name="value" type="STRING"/></arguments></item></menu></menu></scope></commands>';
test('production and paged reading agree on all 150 drift literals, while ordinary trailing arguments link',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
  const external=new Manuals(kit),packs=new FakePacks(),directory=fileURLToPath(new URL('../',import.meta.url));
  const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
  const handle:ProductHandle={id:'apv',version:'1.3.0',digest:createHash('sha256').update(readFileSync(new URL('../pack.json',import.meta.url))).digest('hex'),kind:'product',directory,product};packs.add(handle);
  const literals=Array.from({length:150},(_,i)=>`demo missing${i}`);
  const manual=['# 合成章节','',`合法的准备提法是 \`demo pool add HostName\`。`,'',literals.map(literal=>`提到 \`${literal}\`。`).join('，')].join('\n');
  external.set('site:tree:links',{bytes:tree,mediaType:'application/xml'});external.set('manual:cli:10.6.1',{bytes:manual,mediaType:'text/markdown'});
  const knowledge=createKnowledge({records:kit,parsers:createDefaultRegistry(),packs,external,jev:null,admin,sandbox:{requireOsIsolation:await osIsolationAvailable()}});
  const build:KnownBuild={name:'Rel_APV_10_6_1_99',family:'APV',line:'10.6.1',base:'Rel_APV_10_6_1_99',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:links'},root:null};
  const produced=await knowledge.produceTree({product:handle,build,by:admin});assert.ok(produced.ok,produced.reason??'');
  const warning=produced.warnings.find(text=>text.startsWith('链接声明 manual-literals'));
  assert.ok(warning);assert.match(warning,/有 150 个字面/);assert.ok(!warning.includes('HostName'));
  const reader=createKnowledgeReader(knowledge),drift:string[]=[];let cursor:string|null=null,linked=0,pages=0;
  do{
    const result=await reader.read('knowledge:links:apv:10.6.1?limit=20'+(cursor?'&cursor='+cursor:''),{principal:admin,run:null,purpose:'synthetic',composition:produced.composition});assert.ok(result.ok,result.ok?'':result.reason);
    const bytes=await kit.objects.get(result.artifacts[0].artifact.body.sha256);assert.ok(bytes);
    const view=LinksView.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));assert.equal(view.totals?.drift_literals,150);assert.equal(view.totals?.links,1);
    drift.push(...view.drift.map(group=>group.literal));linked+=view.links.length;cursor=view.next;pages++;
  }while(cursor);
  assert.ok(pages>1);assert.equal(linked,1);assert.deepEqual(drift.sort(),literals.sort());
});
