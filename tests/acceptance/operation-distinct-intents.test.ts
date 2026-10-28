import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {startPostgres} from '../../hub/testing/postgres.ts';
import {osIsolationAvailable} from '../../hub/rules/api.ts';
import {sha256Hex} from '../../hub/records/api.ts';
import {openBed} from './support/hub.ts';
import {productSite} from './support/env.ts';
import {SESSION,scratch,enable,hook,skill} from '../../packs/workflow/knowledge-contribution/testing/operation-support.ts';
import {sessionDirectory} from '../../packs/workflow/knowledge-contribution/tools/operation-capture/lib/common.ts';

test('one capture can support distinct integration runs while an identical retry reuses its run',async t=>{
  if(!await osIsolationAvailable()){t.skip('sandbox-exec 不可用；未验证真实 Hub 沙箱验收');return;}
  const postgres=await startPostgres();t.after(()=>postgres.stop());
  const bed=await openBed({postgres,syncOneName:false});t.after(()=>bed.close());
  await bed.hub.assignPack(bed.reviewer.principal,'knowledge-contribution');
  const site=await productSite(),local=await scratch(t);
  await writeFile(local.tokenFile,bed.reviewer.token+'\n',{mode:0o600});
  assert.equal((await enable(local,bed.hub.mcpUrl)).code,0);
  const source='ORBIT synthetic status: ready\n';
  assert.equal((await hook(local,source)).code,0);
  const produced=bed.syncs.two?.builds.find(build=>build.name===site.RELEASED&&build.outcome==='produced'&&build.root!==null);
  assert.ok(produced?.root);
  const client=await bed.connect(bed.reviewer,SESSION);
  const tree=await client.call('get_nodes',{root:produced.root,paths:['/commands'],depth:6});
  const node=tree.out.nodes?.find(row=>row.entries.some(entry=>Array.isArray((entry.data as {words?:unknown}|undefined)?.words)));
  assert.ok(node);
  const capture=sha256Hex(source),path=node.path,proposal=join(local.home,'intent.json');
  const receiptFile=join(sessionDirectory(SESSION,{CIRCLE_HOME:local.home}),'receipts.jsonl');
  const submit=async(item:unknown)=>{
    await writeFile(proposal,JSON.stringify({schema:'operation-integration@1',session:SESSION,items:[item]}));
    const result=await skill(local,['submit','--session',SESSION,'--proposals',proposal,'--product',bed.product.names[0],'--build',site.RELEASED,'--model','synthetic-model']);
    assert.equal(result.code,0,result.err);
    const lines=(await readFile(receiptFile,'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line));
    const receipt=lines.at(-1).receipt;assert.equal(receipt.acceptance,'accepted');
    return receipt;
  };
  const observation={capture,kind:'observation',path,statement:'记录合成状态',action:'查看合成状态',quote:{line:1,text:'ORBIT synthetic status: ready'}};
  const first=await submit(observation),retry=await submit(observation);
  assert.equal(retry.result.run,first.result.run);
  assert.equal(retry.result.submission,first.result.submission);
  const pitfall={capture,kind:'pitfall',path,statement:'合成注意事项',phenomenon:'合成状态已显示',suggestion:'核对合成输入',quote:observation.quote};
  const second=await submit(pitfall);
  assert.notEqual(second.result.run,first.result.run);
  assert.equal(first.result.contributions.stored.length,1);
  assert.equal(second.result.contributions.stored.length,1);
});
