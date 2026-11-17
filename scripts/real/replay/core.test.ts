import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { capture, inspectBundle } from './bundle.ts';
function source() {
  const dir = mkdtempSync(join(tmpdir(), 'circle-replay-test-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const app = join(dir, 'app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ version: '1.17.0' }));
  writeFileSync(join(app, 'dist', 'harness.js'), 'export class Harness {}');
  const db = new DatabaseSync(join(home, 'circle.sqlite'));
  db.exec('create table sessions(id text primary key,workspace text,title text,model text,head text,created real,updated real,parent_id text);create table checkpoints(id text primary key,session_id text,parent text,message text,created real);create table context_versions(version integer,checkpoint_id text,state text,created real)');
  db.prepare('insert into sessions values(?,?,?,?,?,?,?,?)').run('s', join(dir, 'work'), 'synthetic', 'scripted', 'c4', 1, 4, null);
  const messages = [
    { id: 'm1', role: 'user', content: 'synthetic request', display: 'synthetic request' },
    { id: 'm2', role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'read_file', args: { file_path: 'a.txt' } }], completion: { reason: 'tool_calls' } },
    { id: 'm3', role: 'tool', name: 'read_file', content: 'synthetic bytes', status: 'success', tool_call_id: 't1' },
    { id: 'm4', role: 'assistant', content: 'done', completion: { reason: 'stop' } },
  ];
  messages.forEach((m, i) => db.prepare('insert into checkpoints values(?,?,?,?,?)').run(`c${i + 1}`, 's', i ? `c${i}` : null, JSON.stringify(m), i + 1));
  db.close();
  return { dir, home, app, out: join(dir, 'bundle'), close: () => rmSync(dir, { recursive: true, force: true }) };
}
test('capture preserves source bytes and inspect checks pairings and manifests', () => {
  const s = source();
  try {
    const before = readFileSync(join(s.home, 'circle.sqlite'));
    capture({ home: s.home, session: 's', app: s.app, out: s.out });
    const b = inspectBundle(s.out);
    assert.equal(b.counts.messages, 4);
    assert.equal(b.counts.calls, 1);
    assert.deepEqual(readFileSync(join(s.home, 'circle.sqlite')), before);
    assert.throws(() => capture({ home: s.home, session: 's', app: s.app, out: s.out }));
    writeFileSync(join(s.out, 'events.jsonl'), 'tampered');
    assert.throws(() => inspectBundle(s.out));
  }
  finally {
    s.close();
  }
});
test('unpaired results and broken ancestry never become a successful replay bundle', () => {
  for (const mutation of ['result', 'head']) {
    const s = source();
    try {
      const db = new DatabaseSync(join(s.home, 'circle.sqlite'));
      if (mutation === 'result')
        db.prepare('update checkpoints set message=? where id=?').run(JSON.stringify({ id: 'm3', role: 'tool', name: 'read_file', content: 'x', status: 'success', tool_call_id: 'other' }), 'c3');
      else
        db.exec("update sessions set head='missing'");
      db.close();
      assert.throws(() => capture({ home: s.home, session: 's', app: s.app, out: s.out }));
    }
    finally {
      s.close();
    }
  }
});
test('capture refuses Git outputs and symlinked blob replacements', () => {
  const s = source();
  try {
    const repo = join(s.dir, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.git'), 'synthetic marker');
    assert.throws(() => capture({ home: s.home, session: 's', app: s.app, out: join(repo, 'bundle') }));
    capture({ home: s.home, session: 's', app: s.app, out: s.out });
    const b = inspectBundle(s.out);
    const ref = b.sessions[0].records[0].ref;
    const path = join(s.out, 'blobs', ref);
    unlinkSync(path);
    symlinkSync(join(s.home, 'circle.sqlite'), path);
    assert.throws(() => inspectBundle(s.out));
  }
  finally {
    s.close();
  }
});

test('cycle in a selected checkpoint chain is rejected', () => {
  const s=source();try{
    const db=new DatabaseSync(join(s.home,'circle.sqlite'));db.exec("update checkpoints set parent='c4' where id='c1'");db.close();
    assert.throws(()=>capture({home:s.home,session:'s',app:s.app,out:s.out}));
  }finally{s.close();}
});
