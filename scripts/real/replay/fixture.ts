// Synthetic database fixtures only. No live Home, model connection or business adapter is used.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Call, Message } from './types.ts';
export const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, args });
export const user = (id: string, content: string): Message => ({ id, role: 'user', content, display: content });
export const assistant = (id: string, content: string, tool_calls: Call[] = []): Message => ({ id, role: 'assistant', content, tool_calls, completion: { reason: tool_calls.length ? 'tool_calls' : 'stop', provider_reason: tool_calls.length ? 'tool_use' : 'end_turn' } });
export const result = (id: string, name: string, tool_call_id: string, content: string, status: 'success' | 'error' = 'success'): Message => ({ id, role: 'tool', name, tool_call_id, content, status });
export const denial = { kind: 'denied', tool: 'execute', name: 'synthetic guard', reason: 'synthetic refusal' };
export const hook: Message = { id: 'hook', role: 'user', internal: 'hook_notice', hook: denial, content: '<system-reminder data-source="circle-hooks">\nhook denied execute · synthetic refusal\n</system-reminder>', display: 'hook denied execute · synthetic refusal' };
export interface FixtureSession {
  id: string;
  parent?: string;
  messages: Message[];
  contexts?: {
    at: number;
    state: Record<string, unknown>;
  }[];
}
export function fixture(app: string | undefined, sessions: FixtureSession[]) {
  const dir = mkdtempSync(join(tmpdir(), 'circle-replay-test-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  if (!app) {
    app = join(dir, 'app');
    mkdirSync(join(app, 'dist'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ version: '1.17.0' }));
    writeFileSync(join(app, 'dist', 'harness.js'), 'export class Harness {}');
  }
  const db = new DatabaseSync(join(home, 'circle.sqlite'));
  db.exec('create table sessions(id text primary key,workspace text,title text,model text,head text,created real,updated real,parent_id text);create table checkpoints(id text primary key,session_id text,parent text,message text,created real);create table context_versions(version integer,checkpoint_id text,state text,created real)');
  let version = 0;
  sessions.forEach((s, index) => {
    db.prepare('insert into sessions values(?,?,?,?,?,?,?,?)').run(s.id, join(dir, 'work'), 'synthetic', 'scripted', `${s.id}-${s.messages.length - 1}`, index, index + 1, s.parent ?? null);
    s.messages.forEach((m, i) => db.prepare('insert into checkpoints values(?,?,?,?,?)').run(`${s.id}-${i}`, s.id, i ? `${s.id}-${i - 1}` : null, JSON.stringify(m), i + index));
    for (const c of s.contexts ?? [])
      db.prepare('insert into context_versions values(?,?,?,?)').run(++version, `${s.id}-${c.at}`, JSON.stringify(c.state), version);
  });
  db.close();
  return { dir, home, app, bundle: join(dir, 'bundle'), close: () => rmSync(dir, { recursive: true, force: true }) };
}
export function parallelFixture(app: string | undefined) {
  return fixture(app, [{ id: 's0', messages: [user('u', 'synthetic request'), assistant('a', '', [call('t1', 'task', { description: 'child one', subagent_type: 'general-purpose' }), call('t2', 'task', { description: 'child two', subagent_type: 'general-purpose' })]), result('r1', 'task', 't1', 'child one done'), result('r2', 'task', 't2', 'child two done'), { id: 'host', role: 'user', internal: 'loop-guard', content: 'synthetic host reminder' }, assistant('a2', '', [call('bad', 'execute', { command: 'NEVER_EXECUTE_ME' })]), result('r3', 'execute', 'bad', 'Hook denied this call: synthetic refusal', 'error'), hook, assistant('a3', 'done')] },
  { id: 's1', parent: 's0', messages: [user('cu1', 'child one'), assistant('ca1', '', [call('c1', 'read_file', { file_path: 'synthetic.txt' })]), result('cr1', 'read_file', 'c1', 'synthetic data'), assistant('cf1', 'child one done')] },
  { id: 's2', parent: 's0', messages: [user('cu2', 'child two'), assistant('ca2', '', [call('c2', 'execute', { command: 'ALSO_NEVER_EXECUTE' })]), result('cr2', 'execute', 'c2', 'synthetic process failure', 'error'), assistant('cf2', 'child two done')] }]);
}
