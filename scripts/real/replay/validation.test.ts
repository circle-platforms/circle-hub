import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { capture, inspectBundle } from './bundle.ts';
import { assistant, call, fixture, parallelFixture, result, user } from './fixture.ts';
import { main } from '../replay-circle.ts';
import { sha } from './types.ts';
test('swapping child results cannot preserve a complete runnable graph', () => {
  const f = parallelFixture(undefined);
  try {
    const db = new DatabaseSync(join(f.home, 'circle.sqlite'));
    for (const [id, callId] of [['s0-2', 't2'], ['s0-3', 't1']]) {
      const r = db.prepare('select message from checkpoints where id=?').get(id)!;
      const m = JSON.parse(String(r.message));
      m.tool_call_id = callId;
      db.prepare('update checkpoints set message=? where id=?').run(JSON.stringify(m), id);
    }
    db.close();
    capture({ home: f.home, session: 's0', app: f.app, out: f.bundle });
    assert.ok(inspectBundle(f.bundle).gaps.some(g => g.blocking));
  }
  finally {
    f.close();
  }
});
test('duplicate task descriptions remain ambiguous instead of being matched by time', () => {
  const child = [user('u1', 'same'), assistant('a1', 'child done')];
  const f = fixture(undefined, [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('t1', 'task', { description: 'same', subagent_type: 'general-purpose' }), call('t2', 'task', { description: 'same', subagent_type: 'general-purpose' })]), result('r1', 'task', 't1', 'child done'), result('r2', 'task', 't2', 'child done'), assistant('done', 'done')] }, { id: 'child', parent: 'root', messages: child }]);
  try {
    capture({ home: f.home, session: 'root', app: f.app, out: f.bundle });
    assert.ok(inspectBundle(f.bundle).gaps.some(g => g.fact.includes('唯一绑定') && g.blocking));
  }
  finally {
    f.close();
  }
});
test('early background completion fails structural verification even with recomputed file hashes', () => {
  const notice = { id: 'n', role: 'user' as const, internal: 'job_notice', display: '◆ j1 done · synthetic · 1s', content: '<system-reminder data-source="circle-jobs">\nj1 · shell · done\n</system-reminder>' };
  const f = fixture(undefined, [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('j', 'execute', { command: 'synthetic', background: true })]), result('r', 'execute', 'j', 'In background: j1 · shell · running'), notice, assistant('done', 'done')] }]);
  try {
    capture({ home: f.home, session: 'root', app: f.app, out: f.bundle });
    const file = join(f.bundle, 'events.jsonl');
    const events = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    events.find(e => e.checkpoint === 'root-3').dependsOn = [];
    const raw = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(file, raw);
    const source = JSON.parse(readFileSync(join(f.bundle, 'source.json'), 'utf8'));
    source.indexHashes['events.jsonl'] = sha(raw);
    writeFileSync(join(f.bundle, 'source.json'), JSON.stringify(source));
    assert.throws(() => inspectBundle(f.bundle));
  }
  finally {
    f.close();
  }
});
test('captured text bytes retain whitespace and Unicode and raw messages never reach CLI stdout', async () => {
  const f = fixture(undefined, [{ id: 'root', messages: [user('u', 'synthetic-private-content'), assistant('done', '合成结束')] }]);
  try {
    const db = new DatabaseSync(join(f.home, 'circle.sqlite'));
    const raw = ' { "id": "u", "role": "user", "content": "synthetic-private-content", "display": "合成" }\n';
    db.prepare('update checkpoints set message=? where id=?').run(raw, 'root-0');
    db.close();
    const lines: string[] = [];
    assert.equal(await main(['capture', '--home', f.home, '--session', 'root', '--circle-app', f.app, '--out', f.bundle], line => lines.push(line)), 0);
    const b = inspectBundle(f.bundle);
    assert.equal(readFileSync(join(f.bundle, 'blobs', b.sessions[0].records[0].ref), 'utf8'), raw);
    assert.doesNotMatch(lines.join(''), /synthetic-private-content|合成结束|合成/);
    assert.equal(await main(['inspect', '--bundle', f.bundle, '--source-sha', '0'.repeat(64)], line => lines.push(line)), 1);
    assert.equal(await main(['run'], () => { }), 1);
  }
  finally {
    f.close();
  }
});

test('unsupported Circle versions are unavailable before any harness module executes', async () => {
  const f=fixture(undefined,[{id:'root',messages:[user('u','synthetic'),assistant('done','done')]}]);
  try{
    writeFileSync(join(f.app,'package.json'),JSON.stringify({version:'9.0.0'}));capture({home:f.home,session:'root',app:f.app,out:f.bundle});
    const lines:string[]=[];assert.equal(await main(['run','--bundle',f.bundle,'--circle-app',f.app,'--out',join(f.dir,'out')],line=>lines.push(line)),2);
    const r=JSON.parse(readFileSync(join(f.dir,'out','report.json'),'utf8'));assert.equal(r.status,'unavailable');assert.equal(r.actual.messages,0);
  }finally{f.close();}
});

test('ambiguous repeated Hook denials are retained as missing evidence rather than guessed', async () => {
  const denial={kind:'denied',tool:'execute',name:'synthetic',reason:'same reason'};
  const notice=(id:string)=>({id,role:'user' as const,internal:'hook_notice',content:'synthetic notice',hook:denial});
  const f=fixture(undefined,[{id:'root',messages:[user('u','synthetic'),assistant('a','',[call('x','execute',{command:'one'}),call('y','execute',{command:'two'})]),result('r1','execute','x','Hook denied this call: same reason','error'),notice('n1'),result('r2','execute','y','Hook denied this call: same reason','error'),notice('n2'),assistant('done','done')]}]);
  try{
    capture({home:f.home,session:'root',app:f.app,out:f.bundle});const b=inspectBundle(f.bundle);assert.equal(b.counts.denials,2);assert.ok(b.gaps.some(g=>g.blocking&&g.fact.includes('Hook')));
    assert.equal(await main(['inspect','--bundle',f.bundle],()=>{}),2);
  }finally{f.close();}
});
