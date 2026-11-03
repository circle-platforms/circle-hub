// Real product production and team mount; all inputs are the package's synthetic fixtures.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {makeWorld,startPostgres,catalogXml,BASE_CATALOG} from './test-support.ts';
import {canonicalize} from '../records/api.ts';
import {openRecords} from '../records/index.ts';
import {Database,createPool} from '../records/db.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {sandboxSkip} from '../runs/engine/testing/harness.ts';
const skip=await sandboxSkip();
test('startup resumes retirement beside a real produced product mounted in the team tree',{skip},async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());const w=await makeWorld(postgres);t.after(w.close);
 w.external.set('site:tree:Rel_ACME_1_2_15',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const produced=await w.knowledge.produceTree({product:w.product,build:{name:'Rel_ACME_1_2_15',family:'ACME',line:'1.2',base:'Rel_ACME_1_2_15',platform:null,root:null,built_at:'2026-01-02T10:00:00.000Z',released_at:'2026-01-05T00:00:00.000Z',sources:{tree:'site:tree:Rel_ACME_1_2_15'}}});
 assert.ok(produced.ok,produced.reason??'');assert.ok(produced.root);assert.ok(produced.action);
 await w.knowledge.moveRoot(w.product.product.id,'1.2',null,produced.root,produced.action,{by:w.admin});
 const team=await w.knowledge.spaces!.ensure(w.user,'team'),mount=team.body.products.find(p=>p.root===produced.root);assert.ok(mount);
 assert.equal(await w.kit.objects.stat(mount.root),null);
 const legacy=Buffer.from(canonicalize({name:'synthetic-legacy-private',children:[],entries:[]})),node=(await w.kit.objects.put(legacy,'application/json')).sha256;
 const db=new Database(createPool(w.kit.database));t.after(()=>db.end());
 await db.transaction(async tx=>{await w.kit.personalPayloads!.object(w.user.id,legacy,tx);await db.query('INSERT INTO personal_legacy_retire(sha256) VALUES($1)',[node],tx);});
 const kit=await openRecords({database:w.kit.database,dataDir:w.kit.dataDir,logDir:join(w.kit.dataDir,'logs'),limits:{...DEFAULT_LIMITS}},{migrate:false,keyProvider:w.kit.keyProvider});t.after(()=>kit.close());
 assert.ok(await w.knowledge.store.node(mount.root));assert.ok(await kit.objects.get(team.body.tree));
 assert.equal((await db.query('SELECT 1 FROM personal_legacy_retired WHERE sha256=$1',[node])).rowCount,1);
});
